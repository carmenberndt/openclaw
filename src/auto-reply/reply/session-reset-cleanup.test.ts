// Tests session reset cleanup for stale files and persisted state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../../agents/embedded-agent-runner/session-prompt-state.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import {
  createReplyOperation,
  getSessionControllerOperation,
  isSessionRunActiveForKey,
} from "../../sessions/session-controller.js";
import {
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  tryClaimSessionControllerTask,
} from "../../sessions/session-controller.mailbox.js";
import { clearFollowupQueue } from "./queue/state.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import {
  clearCommittedSessionResetRuntimeState,
  clearSessionResetRuntimeState,
} from "./session-reset-cleanup.js";

afterEach(() => {
  clearEmbeddedSessionPromptStates(["old-session"]);
  replyRunTesting.resetReplyRunRegistry();
  resetDiagnosticRunActivityForTest();
  resetSystemEventsForTest();
});

describe("clearSessionResetRuntimeState", () => {
  it("disposes prompt projections with the archived session", () => {
    const state = getEmbeddedSessionPromptState("old-session");
    state.toolResults.frozen.add("sent-tool-result");

    clearSessionResetRuntimeState(["old-session"], {
      agentId: "main",
      sessionKey: "agent:main:slack:room:1",
      activeReplySessionId: "old-session",
      assertCurrent: () => {},
    });

    expect(getEmbeddedSessionPromptState("old-session")).not.toBe(state);
  });

  it("clears reset queues and drains system events for normalized keys", () => {
    enqueueSystemEvent("stale alpha", withSystemEventOwner({ sessionKey: "alpha" }, "main"));
    enqueueSystemEvent("stale beta", withSystemEventOwner({ sessionKey: "beta" }, "main"));
    enqueueSystemEvent("fresh gamma", withSystemEventOwner({ sessionKey: "gamma" }, "main"));

    const result = clearSessionResetRuntimeState([" alpha ", undefined, " ", "alpha", "beta"], {
      agentId: "main",
      sessionKey: "alpha",
      assertCurrent: () => {},
    });

    expect(result.keys).toEqual(["alpha", "beta"]);
    expect(result.systemEventsCleared).toBe(2);
    expect(peekSystemEvents("agent:main:alpha")).toStrictEqual([]);
    expect(peekSystemEvents("agent:main:beta")).toStrictEqual([]);
    expect(peekSystemEvents("agent:main:gamma")).toEqual(["fresh gamma"]);
  });

  it("preserves events owned by other agents during an agent-scoped reset", () => {
    enqueueSystemEvent("main", withSystemEventOwner({ sessionKey: "global" }, "main"));
    enqueueSystemEvent("alpha", withSystemEventOwner({ sessionKey: "global" }, "alpha"));
    enqueueSystemEvent("beta", withSystemEventOwner({ sessionKey: "global" }, "beta"));

    const result = clearSessionResetRuntimeState(["global", "agent:beta:global"], {
      agentId: " Alpha ",
      sessionKey: "global",
      assertCurrent: () => {},
    });

    expect(result.systemEventsCleared).toBe(1);
    expect(peekSystemEvents("agent:alpha:global")).toEqual([]);
    expect(peekSystemEvents("agent:main:global")).toEqual(["main"]);
    expect(peekSystemEvents("agent:beta:global")).toEqual(["beta"]);
  });

  it("retains archived reply custody until its actual producer returns", async () => {
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });
    operation.attachBackend({ kind: "embedded", cancel, isStreaming: () => false });
    operation.setPhase("running");
    const raw = createDeferred();
    const producer = raw.promise.then(() => operation.complete());
    try {
      clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
        agentId: "main",
        activeReplySessionId: "old-session",
        sessionKey: "agent:main:slack:room:1",
        assertCurrent: () => {},
      });
      expect(cancel).toHaveBeenCalledWith("restart");
      expect(isSessionRunActiveForKey("agent:main:slack:room:1")).toBe(true);
      expect(() =>
        createReplyOperation({
          sessionKey: "agent:main:slack:room:1",
          sessionId: "new-session",
          resetTriggered: false,
        }),
      ).toThrow("already active");
      raw.resolve();
      await producer;
      await operation.ownerSettlement;
      const nextOperation = createReplyOperation({
        sessionKey: "agent:main:slack:room:1",
        sessionId: "new-session",
        resetTriggered: false,
      });
      expect(nextOperation.sessionId).toBe("new-session");
      nextOperation.complete();
    } finally {
      raw.resolve();
      await producer;
    }
  });

  it("does not clear a fresh active reply under the same key when only the archived id is reset", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "new-session",
      resetTriggered: false,
    });
    operation.setPhase("running");

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      agentId: "main",
      activeReplySessionId: "old-session",
      sessionKey: "agent:main:slack:room:1",
      assertCurrent: () => {},
    });

    expect(getSessionControllerOperation("agent:main:slack:room:1")).toBe(operation);
  });

  it("does not clear a replacement admitted while the archived run is cancelling", () => {
    let replacement: ReturnType<typeof createReplyOperation> | undefined;
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel() {
        operation.complete();
        replacement = createReplyOperation({
          sessionKey: "agent:main:slack:room:1",
          sessionId: "old-session",
          resetTriggered: false,
        });
        replacement.setPhase("running");
      },
      isStreaming: () => false,
    });
    operation.setPhase("running");

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      agentId: "main",
      activeReplySessionId: "old-session",
      sessionKey: "agent:main:slack:room:1",
      assertCurrent: () => {},
    });

    expect(replacement).toBeDefined();
    expect(getSessionControllerOperation("agent:main:slack:room:1")).toBe(replacement);
  });

  it("leaves queued reservations for the archived id so session init can rebind them", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      agentId: "main",
      activeReplySessionId: "old-session",
      sessionKey: "agent:main:slack:room:1",
      assertCurrent: () => {},
    });

    expect(operation.phase).toBe("queued");
    expect(getSessionControllerOperation("agent:main:slack:room:1")).toBe(operation);
  });

  it("clears queued sources without cancelling the executing reset turn that requested it", async () => {
    const sessionKey = "agent:main:dashboard:reset-self";
    enqueueSystemEvent("stale", withSystemEventOwner({ sessionKey }, "main"));
    // A `/new` or `/reset` chat turn owns a claimed controller input and runs
    // initSessionState as that claim's operation; its reply signal is the input's.
    const resetTurn = reserveSessionControllerSource(sessionKey, { policy: { mode: "followup" } });
    const claim = tryClaimSessionControllerTask(resetTurn);
    if (!claim) {
      throw new Error("expected reset turn claim");
    }
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "old-session",
      resetTriggered: true,
      mailboxClaim: claim,
      upstreamAbortSignal: claim.abortController.signal,
    });
    const queued = reserveSessionControllerSource(sessionKey, { policy: { mode: "followup" } });
    const onError = vi.fn();
    try {
      withSessionControllerOwner(operation, () =>
        clearCommittedSessionResetRuntimeState({
          previousSessionEntry: { sessionId: "old-session" },
          agentId: "main",
          sessionKey,
          signal: resetTurn.abortSignal,
          onError,
        }),
      );

      expect(onError).not.toHaveBeenCalled();
      expect(resetTurn.abortSignal.aborted).toBe(false);
      expect(queued.abortSignal.aborted).toBe(true);
      expect(peekSystemEvents(sessionKey)).toStrictEqual([]);
      // A clear outside that turn still cancels its claimed input.
      clearFollowupQueue(sessionKey);
      expect(resetTurn.abortSignal.aborted).toBe(true);
    } finally {
      operation.complete();
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    }
  });
});
