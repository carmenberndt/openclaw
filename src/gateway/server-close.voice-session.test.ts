import "../test-utils/prepare-compiled-subprocesses.js";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as sessionTurn from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { readVoiceSessionRecordInTransaction } from "../talk/client-voice-session-store.js";
import {
  appendClientVoiceTranscript,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
} from "../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../talk/provider-types.js";
import { makeBridge } from "../talk/session-runtime.test-support.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { ensureTalkRealtimeRelayVoiceSession } from "./talk/relay/operations.js";
import { createTalkRealtimeRelaySession } from "./talk/relay/session-create.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";

// mock-isolation: Keep upstream polling and its agent runtime out of this close-order fixture.
vi.mock("../sessions/session-upstream-monitor.js", () => ({
  startSessionUpstreamMonitor: () => ({ stop: () => Promise.resolve() }),
}));

it("settles accepted voice transcripts and provider-close finals across scheduler cancellation", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-voice-session-close");
  const entered = createDeferred();
  const release = createDeferred();
  const parentClosed = createDeferred();
  const providerClosing = createDeferred();
  const releaseProvider = createDeferred();
  let closing: Promise<void> | undefined;
  let writing: Promise<void> | undefined;
  let restoreAppend: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    const target = { agentId: "main", sessionKey: "agent:main:voice-close" };
    await ensureClientVoiceAgentSessionEntry(target);
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    const relayTarget = { agentId: "main", sessionKey: "agent:main:relay-voice-close" };
    await ensureClientVoiceAgentSessionEntry(relayTarget);
    const { client } = makeClient("relay-close-client", "operator", ["operator.admin"]);
    kernel.clients.add(client);
    let providerCallbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const providerClose = vi.fn(async () => {
      providerClosing.resolve();
      await releaseProvider.promise;
    });
    const relay = createTalkRealtimeRelaySession({
      context: kernel.gatewayRequestContext,
      connId: client.connId,
      cfg: kernel.cfgAtStart,
      controlSource: "delegation",
      sessionTarget: prepareTalkSessionTarget(kernel.cfgAtStart, relayTarget.sessionKey),
      provider: {
        id: "close-test",
        label: "Close Test",
        isConfigured: () => true,
        createBridge: (callbacks) => {
          providerCallbacks = callbacks;
          return makeBridge({ close: providerClose });
        },
      },
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    providerCallbacks?.onReady?.();
    await ensureTalkRealtimeRelayVoiceSession({
      relaySessionId: relay.relaySessionId,
      connId: client.connId,
      sessionKey: relayTarget.sessionKey,
    });
    let acceptedSignal: AbortSignal | undefined;
    const append = sessionTurn.appendExpectedSessionTranscriptTurn;
    const observer = vi
      .spyOn(sessionTurn, "appendExpectedSessionTranscriptTurn")
      .mockImplementationOnce(async (...args) => {
        acceptedSignal = getAsyncWorkSignal();
        entered.resolve();
        await release.promise;
        return append(...args);
      });
    restoreAppend = () => observer.mockRestore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "accepted-voice-transcript",
      delayMs: 0,
      async run() {
        writing = appendClientVoiceTranscript({
          ...target,
          sessionTarget: { sessionKey: target.sessionKey },
          voiceSessionId,
          entryId: "accepted-before-close",
          role: "user",
          text: "Keep my accepted transcript",
        });
        await writing;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        expectDefined(writing, "Accepted transcript"),
        "Voice transcript settled before its persistence boundary",
      ),
      signal,
    );
    expect(acceptedSignal?.aborted).toBe(false);
    // The first relay append is behind the held writer; the second is still in its outer FIFO.
    providerCallbacks?.onTranscript?.("user", "First accepted relay final", true);
    providerCallbacks?.onTranscript?.("user", "Second accepted relay final", true);
    kernel.scheduler.signal.addEventListener("abort", () => parentClosed.resolve(), { once: true });
    closing = server.close({ reason: "voice settlement close regression" });
    await withinTest(
      awaitGateBeforeSettlement(
        parentClosed.promise,
        closing,
        "Gateway closed before scheduler cancellation",
      ),
      signal,
    );
    expect(acceptedSignal?.aborted).toBe(false);
    await withinTest(
      awaitGateBeforeSettlement(providerClosing.promise, closing, "Provider close was not joined"),
      signal,
    );
    await expect(
      createOrResumeClientVoiceSession({ ...target, origin: "client", voiceSessionId: "too-late" }),
    ).rejects.toThrow("Voice session persistence admission is closed");
    // Provider event dispatch need not inherit the asynchronous close caller's context.
    providerCallbacks?.onTranscript?.("assistant", "Final words during provider close", true);
    release.resolve();
    releaseProvider.resolve();
    await withinTest(Promise.all([writing, closing]), signal);
    expect(providerClose).toHaveBeenCalledOnce();
    const database = new DatabaseSync(
      resolveOpenClawAgentSqlitePath({ agentId: target.agentId, env: fixture.state.env }),
      { readOnly: true },
    );
    try {
      expect(readVoiceSessionRecordInTransaction({ db: database }, voiceSessionId)).toMatchObject({
        hasUserTranscript: true,
        transcriptFailureKeys: [],
      });
      expect(
        readVoiceSessionRecordInTransaction({ db: database }, relay.relaySessionId),
      ).toMatchObject({
        status: "closed",
        hasUserTranscript: true,
        transcriptFailureKeys: [],
      });
      expect(
        database
          .prepare(
            "SELECT event_id FROM transcript_event_identities WHERE event_id LIKE ? ORDER BY seq",
          )
          .all(`voice:${relay.relaySessionId}:%`)
          .map((row) => row.event_id),
      ).toEqual([1, 2, 3].map((sequence) => `voice:${relay.relaySessionId}:${sequence}`));
    } finally {
      database.close();
    }
  } finally {
    vi.useRealTimers();
    release.resolve();
    releaseProvider.resolve();
    await Promise.allSettled([writing, closing]);
    restoreAppend?.();
    clientVoiceSessionTesting.reset();
    await fixture.cleanup();
  }
});
