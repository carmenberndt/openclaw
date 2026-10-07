import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { createClientVoiceConfirmationReadiness } from "../../../talk/client-voice-confirmation-readiness.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../talk/voice-transcript.js";
import type { RelaySession } from "./state.js";
import {
  closeRelayVoiceSession,
  enqueueRelayVoiceTranscript,
  ensureRelayVoiceSession,
} from "./voice.js";

const voiceSessionMocks = vi.hoisted(() => ({
  appendRelayVoiceTranscript: vi.fn(),
  closeRelayVoiceSessionRecord: vi.fn(),
  createOrResumeClientVoiceSession: vi.fn(),
}));

vi.mock("../../../talk/client-voice-session.js", () => voiceSessionMocks);
// This suite proves bounded queue policy; the real Gateway close suite owns persistence settlement.
// mock-isolation: Queue-only cases use synthetic persistence; real shutdown ownership has Gateway coverage.
vi.mock("../../../talk/client-voice-session-lifecycle.js", () => ({
  withClientVoiceSessionSettlement: (run: () => Promise<unknown>) => run(),
}));
// mock-isolation: The mocked voice store has no physical database to borrow.
vi.mock("../../../talk/client-voice-session-write.js", () => ({
  captureClientVoiceSessionWriter: () => ({ release: () => Promise.resolve() }),
}));
// mock-isolation: Exercise retry decisions without wall-clock backoff.
vi.mock("../../../utils/sleep.js", () => ({ sleep: async () => {} }));

function createRelaySession(): {
  session: RelaySession;
  failSession: ReturnType<typeof vi.fn>;
} {
  const failSession = vi.fn(() => {
    void closeRelayVoiceSession(session);
  });
  const session = {
    id: "relay-voice-bounded",
    sessionTarget: {
      agentId: "main",
      sessionKey: "main",
      canonicalKey: "agent:main:work",
      storePath: "/tmp/relay-voice-sessions.sqlite",
    },
    provider: "openai",
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    },
    confirmationReadiness: createClientVoiceConfirmationReadiness({
      agentId: "main",
      voiceSessionId: "relay-voice-bounded",
      flushTranscript: async () => await session.voiceTranscriptQueue.flush(),
    }),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
    failSession,
  } as unknown as RelaySession;
  return { session, failSession };
}

describe("realtime relay voice transcript persistence", () => {
  beforeEach(() => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockReset();
    voiceSessionMocks.closeRelayVoiceSessionRecord.mockReset().mockResolvedValue(undefined);
    voiceSessionMocks.createOrResumeClientVoiceSession.mockReset().mockResolvedValue("voice");
  });

  it.each([false, true])("retries only a known failed creation (unknown=%s)", async (unknown) => {
    const failure = unknown
      ? new SqliteWorkerError("Creation settlement is unknown", "outcome-unknown")
      : new Error("Creation was refused");
    voiceSessionMocks.createOrResumeClientVoiceSession.mockRejectedValueOnce(failure);
    const { session } = createRelaySession();
    expect(await ensureRelayVoiceSession(session)).toBe(false);
    expect(await ensureRelayVoiceSession(session)).toBe(!unknown);
    expect(voiceSessionMocks.createOrResumeClientVoiceSession).toHaveBeenCalledTimes(
      unknown ? 1 : 2,
    );
  });

  it("does not replay an append after an unknown worker outcome", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockRejectedValue(
      new SqliteWorkerError("Transcript settlement is unknown", "outcome-unknown"),
    );
    const { session } = createRelaySession();
    expect(enqueueRelayVoiceTranscript(session, "user", "Keep this accepted utterance")).toBe(true);
    await session.voiceTranscriptQueue.flush();
    await closeRelayVoiceSession(session);
    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledOnce();
    expect(session.context.logGateway.warn).toHaveBeenCalledWith(
      expect.stringContaining("Transcript settlement is unknown"),
    );
  });

  it("bounds stalled finals, drains the accepted prefix, and closes once", async () => {
    const firstAppend = createDeferred();
    const appendEntered = createDeferred();
    voiceSessionMocks.appendRelayVoiceTranscript.mockImplementation(
      async ({ entryId }: { entryId: string }) => {
        if (entryId === "1") {
          appendEntered.resolve();
          await firstAppend.promise;
        }
      },
    );
    const { session, failSession } = createRelaySession();
    let accepted = enqueueRelayVoiceTranscript(session, "user", `  ${"x".repeat(9_000)}  `) ? 1 : 0;

    for (let index = 0; index < 10_000; index += 1) {
      expect(enqueueRelayVoiceTranscript(session, "user", " \t\n ")).toBe(true);
    }

    for (let index = 1; index < 10_000; index += 1) {
      if (
        enqueueRelayVoiceTranscript(
          session,
          index % 2 === 0 ? "user" : "assistant",
          `  ${"x".repeat(9_000)}  `,
        )
      ) {
        accepted += 1;
      }
    }

    expect(accepted).toBe(41);
    await appendEntered.promise;
    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "main",
        sessionTarget: {
          sessionKey: "agent:main:work",
          storePath: "/tmp/relay-voice-sessions.sqlite",
        },
      }),
      expect.objectContaining({ release: expect.any(Function) }),
    );
    expect(failSession).toHaveBeenCalledOnce();
    const close = session.voiceSessionClose;
    expect(close).toBeDefined();
    expect(closeRelayVoiceSession(session)).toBe(close);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();

    firstAppend.resolve();
    await close;

    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledTimes(41);
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.map(
        ([params]) => (params as { entryId: string }).entryId,
      ),
    ).toEqual(Array.from({ length: 41 }, (_, index) => String(index + 1)));
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.every(
        ([params]) => (params as { text: string }).text.length === 8_000,
      ),
    ).toBe(true);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
    expect(enqueueRelayVoiceTranscript(session, "user", "too late")).toBe(false);
  });
});
