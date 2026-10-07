import { DatabaseSync, StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { readSessionTranscriptMessageEvents } from "../config/sessions/session-accessor.sqlite-active-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { recordMutation, seedSession } from "./client-voice-session.fixture.test-support.js";
import {
  appendClientVoiceTranscript,
  assertClientVoiceSessionOpen,
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  isClientVoiceSessionConfirmable,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

// Install shared mocks before fixture imports load the voice persistence graph.
const { useClientVoiceSessionHarness } = await vi.hoisted(
  () => import("./client-voice-session.harness.test-support.js"),
);

describe("client voice session worker contract", () => {
  const { releaseHeldWrites, sessionTurnMocks } = useClientVoiceSessionHarness();

  it("persists admission, consult effects, transcript bookkeeping, and close off the caller thread", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey);
    const voiceSessionId = "voice-worker-boundary";
    const observation = observeHostDataSql();
    try {
      await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
      await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
      await recordMutation(voiceSessionId);
      await appendClientVoiceTranscript({
        ...target,
        sessionTarget: { sessionKey: target.sessionKey },
        voiceSessionId,
        entryId: "user-1",
        role: "user",
        text: "Send the update",
      });
      await closeClientVoiceSession({ ...target, voiceSessionId, config: {} });
      expect(observation.queries.filter((sql) => /\bcache_entries\b/i.test(sql))).toEqual([]);
    } finally {
      observation.restore();
    }
    expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toMatchObject({
      status: "closed",
      hasUserTranscript: true,
      transcriptFailureKeys: [],
      consultRunIds: [`run-${voiceSessionId}`],
      effects: [{ runId: `run-${voiceSessionId}`, toolName: "message", status: "succeeded" }],
    });
  });

  it("refuses revoked admission after waiting for the existing writer FIFO", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey);
    const entered = createDeferred();
    const release = createDeferred();
    releaseHeldWrites.push(() => release.resolve());
    const blocker = runOpenClawAgentWorkerWrite({ agentId: target.agentId }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    const voiceSessionId = "voice-revoked-admission";
    const creating = createOrResumeClientVoiceSession({
      ...target,
      voiceSessionId,
      origin: "client",
      assertCurrent: () => controller.signal.throwIfAborted(),
    });
    controller.abort(new Error("voice access revoked"));
    const rejected = expect(creating).rejects.toThrow("voice access revoked");
    release.resolve();
    await blocker;
    await rejected;
    expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toBeUndefined();
  });

  it("reuses tool facts until the call changes and rejects a cached call after close", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    const voiceSessionId = await createOrResumeClientVoiceSession({
      ...target,
      origin: "client",
      transcriptCapable: true,
    });
    const binding = { ...target, voiceSessionId };
    expect(assertClientVoiceSessionOpen(binding)).toBe("client");
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(assertClientVoiceSessionOpen(binding)).toBe("client");
      expect(isClientVoiceSessionConfirmable(binding)).toBe(true);
      expect(
        observation.queries.filter((query) => /select.*value_json.*cache_entries/is.test(query)),
      ).toEqual([]);
    } finally {
      observation.restore();
    }
    await closeClientVoiceSession({ ...binding, config: {} });
    expect(() => assertClientVoiceSessionOpen(binding)).toThrow("voice session is closed");
    expect(isClientVoiceSessionConfirmable(binding)).toBe(true);
  });

  it("rejects a transcript after another connection closes the admitted call", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey);
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    expect(assertClientVoiceSessionOpen({ ...target, voiceSessionId })).toBe("client");
    const foreign = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: target.agentId }));
    try {
      foreign
        .prepare(
          "UPDATE cache_entries SET value_json = json_set(value_json, '$.status', 'closed', '$.closedAt', 42) WHERE scope = ? AND key = ?",
        )
        .run("talk-client-voice-sessions", voiceSessionId);
    } finally {
      foreign.close();
    }
    await expect(
      appendClientVoiceTranscript({
        ...target,
        sessionTarget: { sessionKey: target.sessionKey },
        voiceSessionId,
        entryId: "foreign-close",
        role: "user",
        text: "This call has already closed",
      }),
    ).rejects.toThrow("voice session is closed");
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).not.toHaveBeenCalled();
    expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 42,
      transcriptFailureKeys: [],
    });
  });

  it("publishes transcripts only after their voice bookkeeping commits", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey);
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    const observed: Array<{
      transcript: ReturnType<typeof readSessionTranscriptMessageEvents>;
      voice: ReturnType<typeof clientVoiceSessionTesting.readRecord>;
    }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      if (update.sessionKey === target.sessionKey) {
        observed.push({
          transcript: readSessionTranscriptMessageEvents(update.target),
          voice: clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId),
        });
      }
    });
    try {
      await appendClientVoiceTranscript({
        ...target,
        sessionTarget: { sessionKey: target.sessionKey },
        voiceSessionId,
        entryId: "committed-together",
        role: "user",
        text: "Confirm both records before notifying observers",
      });
      expect(observed).toEqual([
        {
          transcript: [
            expect.objectContaining({
              event: expect.objectContaining({
                message: expect.objectContaining({
                  content: [
                    { type: "text", text: "Confirm both records before notifying observers" },
                  ],
                }),
              }),
            }),
          ],
          voice: expect.objectContaining({
            hasUserTranscript: true,
            transcriptFailureKeys: [],
          }),
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("rolls back the transcript when voice ownership changes after reservation", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey);
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    const actualAppend = sessionTurnMocks.actualAppendSessionTranscriptTurn;
    if (!actualAppend) {
      throw new Error("expected the real transcript append implementation");
    }
    let reserved: ReturnType<typeof clientVoiceSessionTesting.readRecord>;
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementationOnce(async (...args) => {
      reserved = clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId);
      const foreign = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: target.agentId }));
      try {
        foreign
          .prepare(
            "UPDATE cache_entries SET value_json = json_set(value_json, '$.sessionKey', ?) WHERE scope = ? AND key = ?",
          )
          .run("agent:main:replacement", "talk-client-voice-sessions", voiceSessionId);
      } finally {
        foreign.close();
      }
      return actualAppend(...args);
    });
    const notified = vi.fn();
    const unsubscribe = onSessionTranscriptUpdate(notified);
    try {
      await expect(
        appendClientVoiceTranscript({
          ...target,
          sessionTarget: { sessionKey: target.sessionKey },
          voiceSessionId,
          entryId: "ownership-replaced",
          role: "user",
          text: "Must not outlive the voice owner",
        }),
      ).rejects.toThrow("voice session does not belong to this agent session");
      expect(reserved?.transcriptFailureKeys).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
      expect(notified).not.toHaveBeenCalled();
      expect(
        readSessionTranscriptMessageEvents({ ...target, sessionId: "session-agent-main-main" }),
      ).toEqual([]);
      expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toMatchObject({
        sessionKey: "agent:main:replacement",
        transcriptFailureKeys: reserved?.transcriptFailureKeys,
      });
      expect(
        clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)?.hasUserTranscript,
      ).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});
