import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createSessionEntryWithTranscript } from "../config/sessions/session-accessor.entry-mutation.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as sessionEvents from "../config/sessions/session-accessor.sqlite-events.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { resetClientVoiceConfirmationStateForTest } from "./client-voice-confirmation.test-support.js";
import {
  captureClientVoiceSessionSettlement,
  prepareClientVoiceSessionClose,
} from "./client-voice-session-lifecycle.js";
import * as voiceSessionReads from "./client-voice-session-read.js";
import * as voiceWriters from "./client-voice-session-write.js";
import { ensureClientVoiceAgentSessionEntry } from "./client-voice-session-write.js";
import {
  completeRun,
  recordMutation,
  seedSession,
} from "./client-voice-session.fixture.test-support.js";
import {
  appendClientVoiceTranscript,
  appendRelayVoiceTranscript,
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  flushClientVoiceSessionWrites,
  resolveClientVoiceAgentSessionId,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";
import { VoiceTranscriptOperationRegistry } from "./voice-transcript.js";

const { sendDurableMessageBatch } = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent" })),
}));
const acceptedDigestWork = vi.hoisted(() => new Set<Promise<void>>());

vi.mock("./client-voice-session-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client-voice-session-lifecycle.js")>();
  return {
    ...actual,
    captureClientVoiceSessionSettlement(
      ...args: Parameters<typeof actual.captureClientVoiceSessionSettlement>
    ) {
      const accepted = actual.captureClientVoiceSessionSettlement(...args);
      let finish!: () => void;
      const completed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      acceptedDigestWork.add(completed);
      return {
        run<T>(run: () => T): T {
          return accepted.run(run);
        },
        release() {
          try {
            accepted.release();
          } finally {
            acceptedDigestWork.delete(completed);
            finish();
          }
        },
      };
    },
  };
});

async function settleDigestAttempts(): Promise<void> {
  while (acceptedDigestWork.size > 0) {
    await Promise.all(acceptedDigestWork);
  }
}

vi.mock("../channels/message/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/message/runtime.js")>();
  return {
    ...actual,
    sendDurableMessageBatchCore: sendDurableMessageBatch,
  };
});

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let tempDir: string;

describe("client voice session lifecycle", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-digest-retry-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    sendDurableMessageBatch.mockReset().mockResolvedValue({ status: "sent" });
  });

  afterEach(async () => {
    await settleDigestAttempts();
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    await cleanupSessionStateForTest({ stateDir: tempDir });
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.for([false, true])(
    "preserves a displaced metadata file and confirmed send through marker retry (replacement=%s)",
    async (replacement, { signal }) => {
      const sessionKey = "agent:main:main";
      await seedSession(sessionKey, { channel: "discord", to: "channel:marker-retry" });
      const voiceSessionId = await createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
      });
      await recordMutation(voiceSessionId);
      await completeRun(`run-${voiceSessionId}`);
      const metadataPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const savedPath = `${metadataPath}.displaced`;
      const sending = createDeferred();
      const finishSend = createDeferred();
      sendDurableMessageBatch.mockImplementationOnce(async () => {
        sending.resolve();
        await finishSend.promise;
        return { status: "sent" };
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await withinTest(sending.promise, signal);
        // Context replacement while send is active must share its later committed delivery fact.
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await closeOpenClawAgentDatabasesAsync(tempDir);
        await fs.rename(metadataPath, savedPath);
        if (replacement) {
          await fs.writeFile(metadataPath, new Uint8Array());
        }
        finishSend.resolve();
        await settleDigestAttempts();
        const afterMarker = await fs.stat(metadataPath).catch((error: unknown) => {
          expect(error).toMatchObject({ code: "ENOENT" });
          return undefined;
        });
        const untouched = replacement ? afterMarker?.size === 0 : afterMarker === undefined;
        await closeOpenClawAgentDatabasesAsync(tempDir);
        await fs.rm(metadataPath, { force: true });
        await fs.rename(savedPath, metadataPath);
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await settleDigestAttempts();
        expect({ untouched, sends: sendDurableMessageBatch.mock.calls.length }).toEqual({
          untouched: true,
          sends: 1,
        });
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
        ).toEqual(expect.any(Number));
      } finally {
        finishSend.resolve();
        await settleDigestAttempts();
        vi.useRealTimers();
      }
    },
  );

  it("shares a confirmed send across context refresh while the first read waits", async ({
    signal,
  }) => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey, { channel: "discord", to: "channel:read-refresh" });
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    await recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);
    const readStarted = createDeferred();
    const releaseRead = createDeferred();
    const markerFailure = new Error("synthetic marker refusal after confirmed send");
    const capture = voiceWriters.captureClientVoiceSessionWriter;
    let held = false;
    const captureSpy = vi
      .spyOn(voiceWriters, "captureClientVoiceSessionWriter")
      .mockImplementation((params) => {
        const writer = capture(params);
        if (params.physicalSource && !held) {
          held = true;
          const read = writer.read.bind(writer);
          vi.spyOn(writer, "read").mockImplementationOnce(async (id) => {
            readStarted.resolve();
            await releaseRead.promise;
            return read(id);
          });
          vi.spyOn(writer, "mutate").mockRejectedValueOnce(markerFailure);
        }
        return writer;
      });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await closeClientVoiceSession({ ...target, voiceSessionId, config: {} });
      await withinTest(readStarted.promise, signal);
      expect(await closeStaleClientVoiceSessions({ agentId: "main", config: {} })).toBe(0);
      releaseRead.resolve();
      await settleDigestAttempts();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(markerFailure.message));
      expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number));
    } finally {
      releaseRead.resolve();
      await settleDigestAttempts();
      captureSpy.mockRestore();
      warning.mockRestore();
    }
  });

  it("does not replay or mark a partially delivered digest after expiry and re-record", async () => {
    const sessionKey = "agent:main:main";
    await seedSession(sessionKey, { channel: "discord", to: "channel:partial-digest" });
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    await recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);
    sendDurableMessageBatch.mockImplementationOnce(async () => ({
      status: "partial_failed",
      results: [],
      sentBeforeError: true,
      receipt: { platformMessageIds: ["partial-message"], parts: [], sentAt: 123 },
      error: new Error("partial delivery"),
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
      await settleDigestAttempts();
      await vi.advanceTimersByTimeAsync(
        clientVoiceSessionTesting.digestDeliveryPolicy.failureRetentionMs + 1,
      );
      await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
      await closeStaleClientVoiceSessions({ agentId: "main", config: {} });
      await settleDigestAttempts();
      expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toBeUndefined();
      expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
        active: 0,
        retained: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins accepted digest delivery beyond both slots after the closing caller returns", async ({
    signal,
  }) => {
    await seedSession("agent:main:main", { channel: "discord", to: "channel:voice-updates" });
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(
        await createOrResumeClientVoiceSession({
          agentId: "main",
          sessionKey: "agent:main:main",
          origin: "client",
          voiceSessionId: `queued-digest-${index}`,
        }),
      );
    }
    for (const id of ids) {
      await recordMutation(id);
      await completeRun(`run-${id}`);
    }
    const close = prepareClientVoiceSessionClose();
    const caller = new AsyncWorkScope();
    const request = new AsyncLocalStorage<string>();
    const started = ids.map(() => createDeferred());
    const release = ids.map(() => createDeferred());
    const observedRequests: Array<string | undefined> = [];
    let calls = 0;
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation((message) => {
      failed.reject(new Error(String(message)));
    });
    sendDurableMessageBatch.mockImplementation(async () => {
      const index = calls++;
      observedRequests.push(request.getStore());
      started[index]!.resolve();
      await release[index]!.promise;
      return { status: "sent" };
    });
    let draining: Promise<void> | undefined;
    try {
      await request.run("closing-request", () =>
        caller.track(async () => {
          for (const voiceSessionId of ids) {
            await closeClientVoiceSession({
              agentId: "main",
              sessionKey: "agent:main:main",
              voiceSessionId,
              config: {},
            });
          }
        }),
      );
      await withinTest(Promise.race([started[1]!.promise, failed.promise]), signal);
      expect(calls).toBe(2);
      caller.beginClose();
      close.beginClose();
      let settled = false;
      draining = close.drain().then(() => {
        settled = true;
      });
      await nextEventLoopTurn();
      expect(settled, "accepted summaries must settle before voice persistence closes").toBe(false);
      release[0]!.resolve();
      release[1]!.resolve();
      await withinTest(Promise.race([started[3]!.promise, failed.promise]), signal);
      release[2]!.resolve();
      release[3]!.resolve();
      await withinTest(Promise.race([draining, failed.promise]), signal);
      expect(observedRequests).toEqual([undefined, undefined, undefined, undefined]);
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(4);
      expect(sendDurableMessageBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "discord",
          to: "channel:voice-updates",
          payloads: [{ text: "Voice call changes\n- message: succeeded" }],
        }),
      );
      for (const id of ids) {
        expect(clientVoiceSessionTesting.readRecord("main", id)?.digestDeliveredAt).toEqual(
          expect.any(Number),
        );
      }
    } finally {
      for (const gate of release) {
        gate.resolve();
      }
      await draining;
      await nextEventLoopTurn();
      await caller.drain();
      warning.mockRestore();
    }
  });

  it.for([false, true])(
    "keeps a delayed digest in its original shutdown owner after a state switch (expired successor=%s)",
    async (expiredSuccessor, { signal }) => {
      const sessionKey = "agent:main:main";
      await seedSession(sessionKey, { channel: "discord", to: "channel:original-voice" });
      const closeOriginal = prepareClientVoiceSessionClose();
      const voiceSessionId = await createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
      });
      await recordMutation(voiceSessionId);
      const successorStateDir = path.join(tempDir, "successor");
      const sending = createDeferred();
      const releaseSend = createDeferred();
      const failed = createDeferred<never>();
      void failed.promise.catch(() => {});
      const warning = vi.spyOn(console, "warn").mockImplementation((message) => {
        failed.reject(new Error(String(message)));
      });
      let closeSuccessor: ReturnType<typeof prepareClientVoiceSessionClose> | undefined;
      const drains: Promise<void>[] = [];
      sendDurableMessageBatch.mockImplementationOnce(async () => {
        sending.resolve();
        await releaseSend.promise;
        return { status: "sent" };
      });
      try {
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await settleDigestAttempts();
        expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
          active: 0,
          pending: 0,
          retained: 1,
        });
        expect(sendDurableMessageBatch).not.toHaveBeenCalled();

        setTestEnvValue("OPENCLAW_STATE_DIR", successorStateDir);
        closeSuccessor = prepareClientVoiceSessionClose();
        if (expiredSuccessor) {
          const acceptedSuccessor = captureClientVoiceSessionSettlement();
          const inSuccessor = acceptedSuccessor.run(() => AsyncLocalStorage.snapshot());
          acceptedSuccessor.release();
          await inSuccessor(() => completeRun(`run-${voiceSessionId}`));
        } else {
          await completeRun(`run-${voiceSessionId}`);
        }
        await withinTest(Promise.race([sending.promise, failed.promise]), signal);

        const settled = { original: false, successor: false };
        closeOriginal.beginClose();
        closeSuccessor.beginClose();
        drains.push(
          closeOriginal.drain().then(() => {
            settled.original = true;
          }),
          closeSuccessor.drain().then(() => {
            settled.successor = true;
          }),
        );
        await nextEventLoopTurn();
        expect({ ...settled }).toEqual({ original: false, successor: true });

        releaseSend.resolve();
        await withinTest(Promise.race([Promise.all(drains), failed.promise]), signal);
        setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
        expect(sendDurableMessageBatch).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ to: "channel:original-voice" }),
        );
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
        ).toEqual(expect.any(Number));
      } finally {
        releaseSend.resolve();
        setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
        await Promise.allSettled([closeOriginal.drain(), closeSuccessor?.drain(), ...drains]);
        warning.mockRestore();
        await cleanupSessionStateForTest({ stateDir: successorStateDir });
      }
    },
  );

  it.each([false, true])(
    "records post-close effects and defers the digest until the last consult completes (incognito=%s)",
    async (incognito) => {
      const sessionKey = incognito ? "agent:main:dashboard:incognito-digest" : "agent:main:main";
      const to = incognito ? "channel:incognito-voice-updates" : "channel:voice-updates";
      if (incognito) {
        await seedSession("agent:main:main", { channel: "discord", to: "channel:durable-decoy" });
        await createSessionEntryWithTranscript({ agentId: "main", sessionKey }, () => ({
          ok: true as const,
          entry: {
            incognito: true as const,
            sessionId: "incognito-voice-digest",
            updatedAt: Date.now(),
            delivery: normalizeSessionDeliveryState({ context: { channel: "discord", to } }),
          },
        }));
      } else {
        await seedSession(sessionKey, { channel: "discord", to });
      }
      const voiceSessionId = await createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
      });
      for (const runId of ["run-1", "run-2"]) {
        await registerClientVoiceConsultRun({
          agentId: "main",
          sessionKey,
          voiceSessionId,
          runId,
        });
      }

      await closeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        config: {},
      });
      await settleDigestAttempts();
      expect(sendDurableMessageBatch).not.toHaveBeenCalled();
      expect(resolveClientVoiceRunBinding("run-1")).toMatchObject({ voiceSessionId });

      for (const runId of ["run-1", "run-2"]) {
        emitTrustedDiagnosticEvent({
          type: "tool.execution.started",
          runId,
          toolCallId: "call-1",
          toolName: "message",
          mutatingAction: true,
        });
        emitTrustedDiagnosticEvent({
          type: "tool.execution.completed",
          runId,
          toolCallId: "call-1",
          toolName: "message",
          durationMs: 5,
        });
      }
      await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual([
        expect.objectContaining({ runId: "run-1", status: "succeeded" }),
        expect.objectContaining({ runId: "run-2", status: "succeeded" }),
      ]);

      await completeRun("run-1");
      await settleDigestAttempts();
      expect(sendDurableMessageBatch).not.toHaveBeenCalled();
      await completeRun("run-2");
      await settleDigestAttempts();
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
      expect(sendDurableMessageBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          to,
          payloads: [{ text: "Voice call changes\n- message: succeeded\n- message: succeeded" }],
        }),
      );
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number));

      await closeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        config: {},
      });
      await settleDigestAttempts();
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
      if (incognito) {
        await expect(
          fs.stat(resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" })),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("retries a deferred digest on the next lifecycle trigger after run completion", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    await registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      runId: "run-live",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-live",
      toolCallId: "call-run-live",
      toolName: "message",
      mutatingAction: true,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-live",
      toolCallId: "call-run-live",
      toolName: "message",
      durationMs: 5,
    });
    // Call ends while the consult still runs, so the digest is deferred.
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));
    await completeRun("run-live");
    await settleDigestAttempts();
    expect(clientVoiceSessionTesting.digestDeliverySnapshot().active).toBe(0);
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
    ).toBeUndefined();

    await closeStaleClientVoiceSessions({ agentId: "main", config: {} });
    await settleDigestAttempts();
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt).toEqual(
      expect.any(Number),
    );
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
  });

  it.each(["different path", "same path replacement"] as const)(
    "isolates retained digests while recovering another physical store (%s)",
    async (replacement) => {
      const sessionKey = "agent:main:main";
      await seedSession(sessionKey, { channel: "discord", to: "channel:original-store" });
      const voiceSessionId = await createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
      });
      await recordMutation(voiceSessionId);
      await completeRun(`run-${voiceSessionId}`);
      const originalPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const archivedPath = path.join(tempDir, "original-agent.sqlite");
      const otherState =
        replacement === "different path" ? path.join(tempDir, "other-state") : tempDir;
      const env = captureEnv(["OPENCLAW_STATE_DIR"]);
      sendDurableMessageBatch.mockRejectedValueOnce(new Error("original channel offline"));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await settleDigestAttempts();
        expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
          active: 0,
          retained: 1,
        });
        if (replacement === "same path replacement") {
          await closeOpenClawAgentDatabasesAsync(tempDir);
          await fs.rename(originalPath, archivedPath);
        } else {
          setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
        }
        await seedSession(sessionKey);
        const stale = await createOrResumeClientVoiceSession({
          agentId: "main",
          sessionKey,
          origin: "client",
          now: 1,
        });
        expect(
          await closeStaleClientVoiceSessions({
            agentId: "main",
            config: {},
            now: 6 * 60 * 60_000 + 2,
          }),
        ).toBe(1);
        await settleDigestAttempts();
        expect(clientVoiceSessionTesting.readRecord("main", stale)?.status).toBe("closed");
        expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
          active: 0,
          retained: 1,
        });
        expect(sendDurableMessageBatch).toHaveBeenCalledOnce();

        await createOrResumeClientVoiceSession({
          agentId: "main",
          sessionKey,
          origin: "client",
          voiceSessionId,
        });
        await expect(
          closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} }),
        ).rejects.toThrow("physical source");
        expect(sendDurableMessageBatch).toHaveBeenCalledOnce();

        if (replacement === "same path replacement") {
          await closeOpenClawAgentDatabasesAsync(tempDir);
          await fs.rename(originalPath, path.join(tempDir, "replacement-agent.sqlite"));
          await fs.rename(archivedPath, originalPath);
        }
        env.restore();
        await closeStaleClientVoiceSessions({ agentId: "main", config: {} });
        await settleDigestAttempts();
        expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
        expect(sendDurableMessageBatch).toHaveBeenLastCalledWith(
          expect.objectContaining({ to: "channel:original-store" }),
        );
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
        ).toEqual(expect.any(Number));
      } finally {
        vi.useRealTimers();
        env.restore();
        if (otherState !== tempDir) {
          await cleanupSessionStateForTest({ stateDir: otherState });
        }
      }
    },
  );

  it("keeps a failed digest while a late consult owns the retry", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    await recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);
    sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await closeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        config: {},
      });
      await settleDigestAttempts();
      expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
        active: 0,
        pending: 0,
        retained: 1,
      });

      // The run can register before config arrives; an identical replay must
      // still re-arm the closed session's digest, not return at binding reuse.
      await registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        runId: "late-run",
      });
      await registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        runId: "late-run",
        config: {},
      });
      await settleDigestAttempts();
      await vi.advanceTimersByTimeAsync(
        clientVoiceSessionTesting.digestDeliveryPolicy.failureRetentionMs + 1,
      );
      expect(clientVoiceSessionTesting.digestDeliverySnapshot().retained).toBe(1);

      await recordMutation(voiceSessionId, "late-run");
      await completeRun("late-run");
      await settleDigestAttempts();
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number));
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers one mutation digest and skips webchat or missing targets", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const delivered = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    await recordMutation(delivered);
    await completeRun(`run-${delivered}`);
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId: delivered,
      config: {},
    });
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId: delivered,
      config: {},
    });
    await settleDigestAttempts();
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    expect(sendDurableMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        durability: "required",
        requireUnknownSendReconciliation: true,
        payloads: [{ text: "Voice call changes\n- message: succeeded" }],
      }),
    );

    for (const [voiceSessionId, route] of [
      ["voice-webchat", { channel: "webchat", to: "browser" }],
      ["voice-no-target", {}],
    ] as const) {
      const sessionKey = `agent:main:${voiceSessionId}`;
      await seedSession(sessionKey, route);
      await createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
        voiceSessionId,
      });
      await registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        runId: `run-${voiceSessionId}`,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId: `run-${voiceSessionId}`,
        toolCallId: `call-${voiceSessionId}`,
        toolName: "message",
        mutatingAction: true,
      });
      await completeRun(`run-${voiceSessionId}`);
      await closeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        config: {},
      });
      await settleDigestAttempts();
    }
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { phase: "recovery", replacement: false },
    { phase: "recovery", replacement: true },
    { phase: "publication", replacement: false },
    { phase: "publication", replacement: true },
  ])(
    "does not open a displaced metadata file after $phase (replacement=$replacement)",
    async ({ phase, replacement }) => {
      const target = { agentId: "main", sessionKey: "agent:main:main" };
      await seedSession(target.sessionKey);
      const voiceSessionId = await createOrResumeClientVoiceSession({
        ...target,
        origin: "client",
        now: 1,
      });
      const metadataPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const displace = async () => {
        await closeOpenClawAgentDatabasesAsync(tempDir);
        await fs.rename(metadataPath, `${metadataPath}.displaced`);
        if (replacement) {
          await fs.writeFile(metadataPath, new Uint8Array());
        }
      };
      const lookup = voiceSessionReads.lookupClientVoiceSessions;
      const publish = sessionEvents.publishTranscriptUpdate;
      const boundary =
        phase === "recovery"
          ? vi
              .spyOn(voiceSessionReads, "lookupClientVoiceSessions")
              .mockImplementationOnce(async (...args) => {
                const candidates = await lookup(...args);
                await displace();
                return candidates;
              })
          : vi
              .spyOn(sessionEvents, "publishTranscriptUpdate")
              .mockImplementationOnce(async (...args) => {
                const result = await publish(...args);
                await displace();
                return result;
              });
      try {
        if (phase === "recovery") {
          const warn = vi.fn();
          expect(
            await closeStaleClientVoiceSessions({
              agentId: "main",
              config: {},
              now: 6 * 60 * 60_000 + 2,
              warn,
            }),
          ).toBe(0);
          expect(warn).toHaveBeenCalledOnce();
        } else {
          await expect(
            appendClientVoiceTranscript({
              ...target,
              sessionTarget: { sessionKey: target.sessionKey },
              voiceSessionId,
              entryId: "before-replacement",
              role: "user",
              text: "persisted before replacement",
            }),
          ).rejects.toThrow("Agent database execution admission is closed");
        }
        expect(boundary).toHaveBeenCalledOnce();
        if (replacement) {
          expect(await fs.readFile(metadataPath)).toHaveLength(0);
        } else {
          await expect(fs.stat(metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        boundary.mockRestore();
      }
    },
  );

  describe("stale recovery", () => {
    it.each(["original", "successor"] as const)(
      "keeps stale recovery in its original admission when %s closes after lookup",
      async (closed) => {
        const now = 6 * 60 * 60_000 + 2;
        const target = {
          agentId: "main",
          sessionKey: "agent:main:main",
          origin: "client" as const,
        };
        const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, now: 1 });
        const originalClose = prepareClientVoiceSessionClose();
        let successorClose: ReturnType<typeof prepareClientVoiceSessionClose> | undefined;
        const successor = path.join(tempDir, "successor");
        const env = captureEnv(["OPENCLAW_STATE_DIR"]);
        const lookup = voiceSessionReads.lookupClientVoiceSessions;
        const read = vi
          .spyOn(voiceSessionReads, "lookupClientVoiceSessions")
          .mockImplementationOnce(async (...args) => {
            const candidates = await lookup(...args);
            setTestEnvValue("OPENCLAW_STATE_DIR", successor);
            await createOrResumeClientVoiceSession({ ...target, voiceSessionId, now: 1 });
            successorClose = prepareClientVoiceSessionClose();
            await (closed === "original" ? originalClose : successorClose).drain();
            return candidates;
          });
        try {
          const warn = vi.fn();
          expect(
            await closeStaleClientVoiceSessions({ agentId: "main", config: {}, now, warn }),
          ).toBe(closed === "original" ? 0 : 1);
          expect(warn).toHaveBeenCalledTimes(closed === "original" ? 1 : 0);
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
          env.restore();
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe(
            closed === "original" ? "open" : "closed",
          );
        } finally {
          read.mockRestore();
          env.restore();
          await Promise.all([originalClose.drain(), successorClose?.drain()]);
          await cleanupSessionStateForTest({ stateDir: successor, rootPath: successor });
        }
      },
    );
    it("closes stale records and leaves recent records open", async () => {
      const stale = await createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:stale",
        origin: "client",
        now: 1,
      });
      const recent = await createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:recent",
        origin: "client",
        now: 6 * 60 * 60_000,
      });

      expect(
        await closeStaleClientVoiceSessions({
          agentId: "main",
          config: {},
          now: 6 * 60 * 60_000 + 2,
        }),
      ).toBe(1);
      expect(clientVoiceSessionTesting.readRecord("main", stale)?.status).toBe("closed");
      expect(clientVoiceSessionTesting.readRecord("main", recent)?.status).toBe("open");
    });

    it("does not close a call resumed after the stale candidate read", async () => {
      const now = 6 * 60 * 60_000 + 2;
      const target = { agentId: "main", sessionKey: "agent:main:main", origin: "client" as const };
      const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, now: 1 });
      const lookup = voiceSessionReads.lookupClientVoiceSessions;
      const read = vi
        .spyOn(voiceSessionReads, "lookupClientVoiceSessions")
        .mockImplementationOnce(async (request) => {
          const candidates = await lookup(request);
          await createOrResumeClientVoiceSession({ ...target, voiceSessionId, now });
          return candidates;
        });
      try {
        expect(await closeStaleClientVoiceSessions({ agentId: "main", config: {}, now })).toBe(0);
        expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
      } finally {
        read.mockRestore();
      }
    });

    it("honors an explicit close that joins skipped stale recovery", async () => {
      const now = 6 * 60 * 60_000 + 2;
      const target = { agentId: "main", sessionKey: "agent:main:main", origin: "client" as const };
      const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, now: 1 });
      const entered = createDeferred();
      const release = createDeferred();
      // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the original registry receiver.
      const close = VoiceTranscriptOperationRegistry.prototype.close;
      const barrier = vi
        .spyOn(VoiceTranscriptOperationRegistry.prototype, "close")
        .mockImplementationOnce(function (this: VoiceTranscriptOperationRegistry, key, operation) {
          return close.call(this, key, async () => {
            entered.resolve();
            await release.promise;
            await operation();
          });
        });
      const stale = closeStaleClientVoiceSessions({ agentId: "main", config: {}, now });
      try {
        await entered.promise;
        await createOrResumeClientVoiceSession({ ...target, voiceSessionId, now });
        const explicit = closeClientVoiceSession({ ...target, voiceSessionId, config: {}, now });
        release.resolve();
        await Promise.all([stale, explicit]);
        expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed");
      } finally {
        release.resolve();
        await stale;
        barrier.mockRestore();
      }
    });
  });
  describe("startup", () => {
    it("stamps required Talk creation once", async () => {
      const target = { agentId: "main", sessionKey: "agent:main:talk:new" };
      const actor = { type: "human" as const, source: "profile" as const, id: "profile-required" };
      const creation = { actor, sandbox: "required" as const };
      const sessionId = await ensureClientVoiceAgentSessionEntry({ ...target, creation });

      const original = loadSessionEntry(target);
      expect(original).toMatchObject({
        sessionId,
        createdVia: "talk",
        createdActor: actor,
        createdAt: expect.any(Number),
        sandbox: "required",
      });

      await ensureClientVoiceAgentSessionEntry({
        ...target,
        creation: {
          actor: { type: "human", source: "profile", id: "another-profile" },
          sandbox: "required",
        },
      });
      expect(loadSessionEntry(target)).toEqual(original);
    });

    it.each([
      { origin: "relay" as const, canonicalKey: "global", incognito: false },
      {
        origin: "client" as const,
        canonicalKey: "agent:main:dashboard:incognito-voice",
        incognito: true,
      },
    ])(
      "writes $origin transcripts to $canonicalKey without changing voice identity",
      async ({ origin, canonicalKey, incognito }) => {
        const sessionTarget = {
          sessionKey: canonicalKey,
          storePath: path.join(tempDir, "configured", "sessions.sqlite"),
        };
        const storage = { agentId: "main", ...sessionTarget };
        if (incognito) {
          await createSessionEntryWithTranscript(storage, () => ({
            ok: true as const,
            entry: { incognito: true as const, sessionId: "incognito-voice", updatedAt: 1 },
          }));
        }
        const sessionId = await ensureClientVoiceAgentSessionEntry(storage);
        expect(resolveClientVoiceAgentSessionId(storage)).toBe(sessionId);
        const voiceTarget = { agentId: "main", sessionKey: "main" };
        const voiceSessionId = await createOrResumeClientVoiceSession({ ...voiceTarget, origin });
        const append =
          origin === "client" ? appendClientVoiceTranscript : appendRelayVoiceTranscript;
        await append({
          ...voiceTarget,
          sessionTarget,
          voiceSessionId,
          entryId: "canonical-transcript",
          role: "user",
          text: "Stored in the prepared session",
        });
        expect(readSessionTranscriptMessageEvents({ ...storage, sessionId })).toEqual([
          expect.objectContaining({
            event: expect.objectContaining({
              message: expect.objectContaining({
                content: [{ type: "text", text: "Stored in the prepared session" }],
              }),
            }),
          }),
        ]);
        expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
          sessionKey: "main",
          origin,
          hasUserTranscript: true,
          transcriptFailureKeys: [],
        });
        await expect(
          closeClientVoiceSession({
            agentId: "main",
            sessionKey: canonicalKey,
            voiceSessionId,
            config: {},
          }),
        ).rejects.toThrow("does not belong");
        const firstClosedAt = Date.now();
        await closeClientVoiceSession({
          ...voiceTarget,
          voiceSessionId,
          config: {},
          now: firstClosedAt,
        });
        await closeClientVoiceSession({
          ...voiceTarget,
          voiceSessionId,
          config: {},
          now: firstClosedAt + 1,
        });
        expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
          status: "closed",
          closedAt: firstClosedAt,
        });
      },
    );

    it("does not create an agent session after a browser-session deadline", async () => {
      const sessionKey = "agent:main:talk:expired";

      await expect(
        ensureClientVoiceAgentSessionEntry({
          agentId: "main",
          sessionKey,
          deadlineAt: Date.now() - 1,
        }),
      ).rejects.toThrow("Realtime browser session expired during startup");
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
    });

    it("repairs an incomplete existing row without claiming its creation actor", async () => {
      const sessionKey = "agent:main:talk:incomplete";
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId: "", updatedAt: 1, createdVia: "internal", createdAt: 1 },
      );

      await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey });

      const repaired = loadSessionEntry({ agentId: "main", sessionKey });
      expect(repaired?.sessionId).toBeTruthy();
      expect(repaired).toMatchObject({ createdVia: "internal", createdAt: 1 });
      expect(repaired?.createdActor).toBeUndefined();
    });

    it("does not create a chat when browser startup closes while its write is queued", async () => {
      const entered = createDeferred();
      const release = createDeferred();
      const blocker = patchSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:voice-write-blocker" },
        async () => {
          entered.resolve();
          await release.promise;
          return null;
        },
        { fallbackEntry: { sessionId: "voice-write-blocker", updatedAt: 1 } },
      );
      await entered.promise;
      const target = { agentId: "main", sessionKey: "agent:main:voice-write-cancelled" };
      const controller = new AbortController();
      const creating = ensureClientVoiceAgentSessionEntry({
        ...target,
        assertCommitAllowed: () => controller.signal.throwIfAborted(),
      });
      controller.abort(new Error("browser disconnected"));
      const rejected = expect(creating).rejects.toThrow("browser disconnected");
      release.resolve();
      await blocker;
      await rejected;
      expect(loadSessionEntry(target)).toBeUndefined();
    });
  });
});
