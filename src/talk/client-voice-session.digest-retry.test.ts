import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  completeRun,
  recordMutation,
  seedSession,
} from "./client-voice-session.fixture.test-support.js";
import {
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  flushClientVoiceSessionWrites,
  registerClientVoiceConsultRun,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const { sendDurableMessageBatch } = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: sendDurableMessageBatch,
}));

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let tempDir: string;
let sendEntered = createDeferred();
let failedAttempt = createDeferred();

describe("client voice session digest retry", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-digest-retry-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    sendEntered = createDeferred();
    failedAttempt = createDeferred();
    sendDurableMessageBatch.mockReset().mockImplementation(async () => {
      sendEntered.resolve();
      return { status: "sent" };
    });
    const warn = console.warn;
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      warn(...args);
      if (String(args[0]).includes("deferred voice mutation digest failed: channel offline")) {
        failedAttempt.resolve();
      }
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clientVoiceSessionTesting.reset();
    await cleanupSessionStateForTest({ stateDir: tempDir });
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("records post-close effects and defers the digest until the last consult completes", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    for (const runId of ["run-1", "run-2"]) {
      await registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        runId,
      });
    }

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();

    for (const runId of ["run-1", "run-2"]) {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId,
        toolCallId: `call-${runId}`,
        toolName: "message",
        mutatingAction: true,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.completed",
        runId,
        toolCallId: `call-${runId}`,
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
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    await completeRun("run-2");
    await sendEntered.promise;
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    expect(sendDurableMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "Voice call changes\n- message: succeeded\n- message: succeeded" }],
      }),
    );
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt).toEqual(
      expect.any(Number),
    );

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
  });

  it("releases an unlaunched registration so a closed call can deliver its mutation digest", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey, { channel: "discord", to: "channel:voice-updates" });
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    await recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);
    const release = await registerClientVoiceConsultRun({
      ...target,
      voiceSessionId,
      runId: "never-launched",
    });
    const sent = createDeferred();
    sendDurableMessageBatch.mockImplementationOnce(async () => {
      sent.resolve();
      return { status: "sent" };
    });
    await closeClientVoiceSession({ ...target, voiceSessionId, config: {} });
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    release();
    await sent.promise;
    await flushClientVoiceSessionWrites({ agentId: target.agentId, voiceSessionId });
    expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toMatchObject({
      status: "closed",
      digestDeliveredAt: expect.any(Number),
    });
    release();
    expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
  });

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
    await failedAttempt.promise;
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    expect(clientVoiceSessionTesting.digestDeliverySnapshot().active).toBe(0);
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
    ).toBeUndefined();

    await closeStaleClientVoiceSessions({ agentId: "main", config: {} });
    await sendEntered.promise;
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt).toEqual(
      expect.any(Number),
    );
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
  });

  it("retries the mutation digest after a transient close-time send failure", async () => {
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

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    await failedAttempt.promise;
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    expect(clientVoiceSessionTesting.digestDeliverySnapshot().active).toBe(0);
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
    ).toBeUndefined();

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    await sendEntered.promise;
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt).toEqual(
      expect.any(Number),
    );
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
  });

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
      await failedAttempt.promise;
      await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
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
      await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
      await vi.advanceTimersByTimeAsync(
        clientVoiceSessionTesting.digestDeliveryPolicy.failureRetentionMs + 1,
      );
      expect(clientVoiceSessionTesting.digestDeliverySnapshot().retained).toBe(1);

      await recordMutation(voiceSessionId, "late-run");
      await completeRun("late-run");
      await sendEntered.promise;
      await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
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
    await sendEntered.promise;
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId: delivered });
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
    }
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
  });
});
