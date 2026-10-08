import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import {
  captureClientVoiceSessionSettlement,
  prepareClientVoiceSessionClose,
} from "../../../talk/client-voice-session-lifecycle.js";
import { readVoiceSessionRecord } from "../../../talk/client-voice-session-store.js";
import {
  ensureClientVoiceAgentSessionEntry,
  type ClientVoiceSessionWriter,
} from "../../../talk/client-voice-session-write.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { createGatewayRequestContext } from "../../server-request-context.js";
import { makeContextParams } from "../../server-request-context.test-support.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createIdleRelayProvider } from "./index.test-support.js";
import { closeRelaySession, registerTalkRealtimeRelayAgentRun } from "./operations.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { usePersistentRelayTestState } from "./session-state.test-support.js";
import { relaySessions } from "./state.js";
import { enqueueRelayVoiceTranscript, ensureRelayVoiceSession } from "./voice.js";

const activeRelaySessions = new Map<string, string>();
usePersistentRelayTestState(activeRelaySessions);

describe("relay consult registration authority", () => {
  it("retries a known refused voice write in the database admitted by its creator", async () => {
    const originalEnv = { ...process.env };
    const env = captureEnv(["OPENCLAW_STATE_DIR"]);
    const successor = path.join(process.env.OPENCLAW_STATE_DIR!, "successor-known-failure");
    const config = { agents: { entries: { main: {}, fresh: {} } } };
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => config;
    const created = createTalkRealtimeRelaySession({
      context,
      connId: "conn-known-failure",
      cfg: config,
      provider: createIdleRelayProvider(),
      providerConfig: {},
      instructions: "brief",
      tools: [],
      controlSource: "transcript",
      sessionTarget: prepareTalkSessionTarget(config, "agent:fresh:main"),
    });
    activeRelaySessions.set(created.relaySessionId, "conn-known-failure");
    const relay = relaySessions.get(created.relaySessionId)!;
    const agentId = relay.sessionTarget.agentId;
    const originalPath = resolveOpenClawAgentSqlitePath({ agentId });
    expect(existsSync(originalPath)).toBe(false);
    let writer: ClientVoiceSessionWriter | undefined;
    const create = voiceSessions.createOrResumeClientVoiceSession;
    const creation = vi
      .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
      .mockImplementation((...args) => {
        writer = args[1];
        return create(...args);
      });
    let refused = false;
    const admit = operationAdmission.createSqliteWorkerOperationAdmission;
    const admission = vi
      .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((authorize, attachment) =>
        admit((request, grant) => {
          if (!refused && request.stage === "commit" && writer?.identity.key.startsWith("file:")) {
            refused = true;
            throw new Error("Synthetic voice commit refusal");
          }
          authorize(request, grant);
        }, attachment),
      );
    try {
      expect(await ensureRelayVoiceSession(relay)).toBe(false);
      expect(refused).toBe(true);
      expect(existsSync(originalPath)).toBe(true);
      expect(readVoiceSessionRecord(agentId, relay.id)).toBeUndefined();
      setTestEnvValue("OPENCLAW_STATE_DIR", successor);
      expect(await ensureRelayVoiceSession(relay)).toBe(true);
      expect(readVoiceSessionRecord(agentId, relay.id, { env: originalEnv })?.status).toBe("open");
      expect(existsSync(resolveOpenClawAgentSqlitePath({ agentId }))).toBe(false);
    } finally {
      admission.mockRestore();
      creation.mockRestore();
      env.restore();
      await closeRelaySession(relay, "completed");
      await cleanupSessionStateForTest({ stateDir: successor, rootPath: successor });
    }
  });

  it("refuses a replaced physical source on the already-created fast path", async () => {
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => ({});
    const created = createTalkRealtimeRelaySession({
      context,
      connId: "conn-replaced-source",
      cfg: {},
      provider: createIdleRelayProvider(),
      providerConfig: {},
      instructions: "brief",
      tools: [],
      controlSource: "transcript",
      sessionTarget: prepareTalkSessionTarget({}, "agent:main:main"),
    });
    activeRelaySessions.set(created.relaySessionId, "conn-replaced-source");
    const relay = relaySessions.get(created.relaySessionId)!;
    expect(await ensureRelayVoiceSession(relay)).toBe(true);
    const sourcePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const displaced = `${sourcePath}.original`;
    await closeOpenClawAgentDatabasesAsync(process.env.OPENCLAW_STATE_DIR!);
    renameSync(sourcePath, displaced);
    copyFileSync(displaced, sourcePath);
    const replacement = readFileSync(sourcePath);
    try {
      expect(await ensureRelayVoiceSession(relay)).toBe(false);
      expect(readFileSync(sourcePath)).toEqual(replacement);
    } finally {
      await closeOpenClawAgentDatabasesAsync(process.env.OPENCLAW_STATE_DIR!);
      unlinkSync(sourcePath);
      renameSync(displaced, sourcePath);
      await closeRelaySession(relay, "completed");
    }
  });

  it.each([false, true])(
    "keeps accepted registration and close on the creating source after a state switch (coalesced=%s)",
    async (coalesced) => {
      await withOpenClawTestState(
        { label: "relay-source-switch", scenario: "minimal" },
        async () => {
          await ensureClientVoiceAgentSessionEntry({
            agentId: "main",
            sessionKey: "agent:main:main",
          });
          const originalEnv = { ...process.env };
          const env = captureEnv(["OPENCLAW_STATE_DIR"]);
          const successor = path.join(process.env.OPENCLAW_STATE_DIR!, "successor");
          const context = createGatewayRequestContext(makeContextParams());
          context.getRuntimeConfig = () => ({});
          const created = createTalkRealtimeRelaySession({
            context,
            connId: "conn-source",
            cfg: {},
            provider: createIdleRelayProvider(),
            providerConfig: {},
            instructions: "brief",
            tools: [],
            controlSource: "transcript",
            sessionTarget: prepareTalkSessionTarget({}, "agent:main:main"),
          });
          activeRelaySessions.set(created.relaySessionId, "conn-source");
          const relay = relaySessions.get(created.relaySessionId)!;
          const binding = {
            agentId: relay.sessionTarget.agentId,
            sessionKey: relay.sessionTarget.sessionKey,
            voiceSessionId: relay.id,
          };
          setTestEnvValue("OPENCLAW_STATE_DIR", successor);
          await voiceSessions.createOrResumeClientVoiceSession({ ...binding, origin: "relay" });
          env.restore();
          const persistence = prepareClientVoiceSessionClose();
          const acceptedClose = captureClientVoiceSessionSettlement();
          const entered = createDeferred();
          const resume = createDeferred();
          const blocker = runOpenClawAgentWriteAdmission({ agentId: binding.agentId }, async () => {
            entered.resolve();
            await resume.promise;
          });
          await entered.promise;
          const creating = coalesced ? ensureRelayVoiceSession(relay) : undefined;
          let release: (() => void) | undefined;
          const registered = registerTalkRealtimeRelayAgentRun({
            relaySessionId: relay.id,
            connId: relay.connId,
            sessionKey: binding.sessionKey,
            runId: "source-run",
          }).then(
            (registeredRelease) => {
              release = registeredRelease;
              return undefined;
            },
            (error: unknown) => error,
          );
          try {
            setTestEnvValue("OPENCLAW_STATE_DIR", successor);
            persistence.beginClose();
            resume.resolve();
            expect(await registered).toBeUndefined();
            await creating;
            expect(
              readVoiceSessionRecord(binding.agentId, relay.id, { env: originalEnv }),
            ).toMatchObject({
              consultRunIds: ["source-run"],
              status: "open",
            });
            expect(
              acceptedClose.run(() =>
                enqueueRelayVoiceTranscript(relay, "user", "accepted speech"),
              ),
            ).toBe(true);
            await relay.voiceTranscriptQueue.flush();
            release?.();
            await acceptedClose.run(() => closeRelaySession(relay, "completed"));
            expect(
              readVoiceSessionRecord(binding.agentId, relay.id, { env: originalEnv }),
            ).toMatchObject({
              consultRunIds: ["source-run"],
              hasUserTranscript: true,
              status: "closed",
            });
            expect(readVoiceSessionRecord(binding.agentId, relay.id)).toMatchObject({
              consultRunIds: [],
              status: "open",
            });
          } finally {
            resume.resolve();
            await blocker;
            await registered;
            release?.();
            env.restore();
            await acceptedClose.run(() => closeRelaySession(relay, "completed"));
            acceptedClose.release();
            await persistence.drain();
            await cleanupSessionStateForTest({ stateDir: successor, rootPath: successor });
          }
        },
      );
    },
  );

  it.for(["current", "caller", "relay"] as const)(
    "fences delegated voice registration while queued (%s)",
    async (revoked, { signal }) => {
      const context = createGatewayRequestContext(makeContextParams());
      context.getRuntimeConfig = () => ({});
      const session = createTalkRealtimeRelaySession({
        context,
        connId: "conn-1",
        cfg: {},
        provider: createIdleRelayProvider(),
        providerConfig: {},
        instructions: "brief",
        tools: [],
        controlSource: "transcript",
        sessionTarget: prepareTalkSessionTarget({}, "main"),
      });
      const voiceSessionId = session.relaySessionId;
      activeRelaySessions.set(voiceSessionId, "conn-1");
      const relay = relaySessions.get(voiceSessionId);
      if (!relay) {
        throw new Error("Expected the created relay owner");
      }
      const sessionKey = relay.sessionTarget.sessionKey;
      const queued = createDeferred();
      const entered = createDeferred();
      const releaseQueue = createDeferred();
      let callerCurrent = true;
      let blocker: Promise<void> | undefined;
      let release: (() => void) | undefined;
      const registerVoice = vi.fn(async (assertCurrent: () => void) => {
        blocker = runOpenClawAgentWriteAdmission({ agentId: "main" }, async () => {
          entered.resolve();
          await releaseQueue.promise;
        });
        await entered.promise;
        const pending = voiceSessions.registerClientVoiceConsultRun({
          agentId: "main",
          sessionKey,
          voiceSessionId,
          runId: "run-1",
          assertCurrent,
        });
        queued.resolve();
        return await pending;
      });
      const pending = registerTalkRealtimeRelayAgentRun({
        relaySessionId: voiceSessionId,
        connId: "conn-1",
        sessionKey,
        runId: "run-1",
        callId: "call-1",
        assertCurrent: () => {
          if (!callerCurrent) {
            throw new Error("Accepted caller was cancelled");
          }
        },
        registerVoice,
      });
      const settled = pending.then(
        (registered) => {
          release = registered;
          return undefined;
        },
        (error: unknown) => error,
      );
      try {
        await withinTest(
          Promise.race([
            queued.promise,
            settled.then(() => {
              throw new Error("Relay completed before registration queued");
            }),
          ]),
          signal,
        );
        if (revoked === "caller") {
          callerCurrent = false;
        } else if (revoked === "relay") {
          relay.toolCalls.markCancelled(["call-1"], "cancelled-turn");
        }
        releaseQueue.resolve();
        const error = await settled;
        await blocker;
        expect(registerVoice).toHaveBeenCalledOnce();
        expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.consultRunIds).toEqual(
          revoked === "current" ? ["run-1"] : [],
        );
        if (revoked === "current") {
          expect(error).toBeUndefined();
          expect(voiceSessions.resolveClientVoiceRunBinding("run-1")).toBeDefined();
          expect(relay.activeAgentRuns.size).toBe(1);
          release?.();
        } else {
          expect(error).toMatchObject({
            message:
              revoked === "caller"
                ? "Accepted caller was cancelled"
                : "Realtime provider cancelled the tool call before run registration",
          });
          expect(voiceSessions.resolveClientVoiceRunBinding("run-1")).toBeUndefined();
        }
        expect(relay.activeAgentRuns.size).toBe(0);
        expect(relay.activeAgentToolCalls.size).toBe(0);
      } finally {
        releaseQueue.resolve();
        await settled;
        await blocker;
        release?.();
      }
    },
  );
});
