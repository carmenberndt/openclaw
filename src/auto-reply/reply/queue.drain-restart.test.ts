// Tests queue drain restart behavior when follow-up runs chain together.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  beginGatewayRestartSignalAdmission,
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  tryClaimSessionControllerTask,
} from "../../sessions/session-controller.mailbox.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import {
  createQueueTestRun as createRun,
  createDrainRecorder,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { rememberFollowupDrainCallback } from "./queue/drain.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/enqueue.test-support.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";

installQueueRuntimeErrorSilencer();
const defaults: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
let sequence = 0;
let key: string;
beforeEach(() => {
  resetGatewayWorkAdmission();
  key = `drain-restart-${++sequence}`;
});
afterEach(() => {
  clearFollowupQueue(key);
  resetGatewayWorkAdmission();
});
const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe("followup queue drain restart after idle window", () => {
  it("keeps a detached drain on a live root after its enqueue request returns", async () => {
    const parentReleased = createDeferred();
    const drained = createDeferred();
    const parent = tryBeginGatewayRootWorkAdmission();
    if (!parent) {
      throw new Error("expected parent Gateway work admission");
    }
    let suspensionStarted = false;
    let subordinateAdmissionClosed: boolean | undefined;
    let activeRootCountDuringDrain: number | undefined;
    let generationDuringDrain: unknown;
    const predecessorGeneration = {
      remoteCatalog: null,
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: {} as never,
    };

    try {
      await withPreparedModelRuntimePluginGenerationScope(predecessorGeneration, () =>
        parent.run(async () => {
          expect(getPreparedModelRuntimePluginGeneration()).toBe(predecessorGeneration);
          enqueueFollowupRun(key, createRun({ prompt: "detached" }), defaults);
          scheduleFollowupDrain(key, async () => {
            await parentReleased.promise;
            const suspension = tryBeginGatewaySuspendAdmission(() => {});
            suspensionStarted = suspension !== null;
            try {
              generationDuringDrain = getPreparedModelRuntimePluginGeneration();
              subordinateAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
              activeRootCountDuringDrain = getActiveGatewayRootWorkCount();
            } finally {
              suspension?.rollback();
              drained.resolve();
            }
          });
        }),
      );

      parent.release();
      parentReleased.resolve();
      await drained.promise;

      expect(suspensionStarted).toBe(true);
      expect(subordinateAdmissionClosed).toBe(false);
      expect(activeRootCountDuringDrain).toBe(1);
      expect(generationDuringDrain).toBeUndefined();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      parent.release();
      parentReleased.resolve();
    }
  });

  it("keeps debounce dormant and does not acquire a root after the queue is cleared", async () => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    const key = "test-cleared-debounce-root";
    const run = createRun({ prompt: "clear during debounce" });
    const execute = vi.fn(async () => {});
    try {
      enqueueFollowupRun(key, run, { mode: "followup", debounceMs: 60_000, cap: 50 });
      scheduleFollowupDrain(key, execute);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      clearSessionQueues([key]);
      await run.controllerInput!.settlement.promise;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(execute).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      clearSessionQueues([key]);
      vi.useRealTimers();
      resetGatewayWorkAdmission();
    }
  });

  it("does not retain stale callbacks when scheduleFollowupDrain runs with an empty queue", async () => {
    const stale = createDrainRecorder();
    const fresh = createDrainRecorder();
    scheduleFollowupDrain(key, stale.runFollowup);
    enqueueFollowupRun(key, createRun({ prompt: "after-empty-schedule" }), defaults);
    await nextTurn();
    expect(stale.calls).toHaveLength(0);
    scheduleFollowupDrain(key, fresh.runFollowup);
    await fresh.done.promise;
    expect(stale.calls).toHaveLength(0);
    expect(fresh.calls.map((run) => run.prompt)).toEqual(["after-empty-schedule"]);
  });

  it("restarts an idle drain across distinct enqueue and drain module instances when enqueue refreshes the callback", async () => {
    const drainA = await importFreshModule<typeof import("./queue/drain.js")>(
      import.meta.url,
      "./queue/drain.js?scope=restart-a",
    );
    const enqueueB = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=restart-b",
    );
    const calls: FollowupRun[] = [];
    const firstProcessed = createDeferred();

    resetRecentQueuedMessageIdDedupe();

    try {
      const runFollowup = async (run: FollowupRun) => {
        calls.push(run);
        if (calls.length === 1) {
          firstProcessed.resolve();
        }
      };

      enqueueB.enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), defaults);
      drainA.scheduleFollowupDrain(key, runFollowup);
      await firstProcessed.promise;

      await nextTurn();

      enqueueB.enqueueFollowupRun(
        key,
        createRun({ prompt: "after-idle" }),
        defaults,
        "message-id",
        runFollowup,
      );

      await vi.waitFor(
        () => {
          expect(calls).toHaveLength(2);
        },
        { timeout: 1_000 },
      );

      expect(calls[0]?.prompt).toBe("before-idle");
      expect(calls[1]?.prompt).toBe("after-idle");
    } finally {
      clearSessionQueues([key]);

      resetRecentQueuedMessageIdDedupe();
    }
  });

  it("does not double-drain when a message arrives while drain is still running", async () => {
    const key = `test-no-double-drain-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const allProcessed = createDeferred();
    let runFollowupResolve: (() => void) | undefined;
    const runFollowupGate = new Promise<void>((res) => {
      runFollowupResolve = res;
    });
    const runFollowup = async (run: FollowupRun) => {
      await runFollowupGate;
      calls.push(run);
      if (calls.length >= 2) {
        allProcessed.resolve();
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "first" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    enqueueFollowupRun(key, createRun({ prompt: "second" }), settings);
    if (!runFollowupResolve) {
      throw new Error("Expected followup run release callback to be initialized");
    }
    runFollowupResolve();

    await allProcessed.promise;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("first");
    expect(calls[1]?.prompt).toBe("second");
  });

  it("does not reschedule a drain after an active restart-drain rejection", async () => {
    resetGatewayWorkAdmission();
    const key = `test-restart-drain-rejection-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const firstFailed = createDeferred();
    let attempts = 0;

    const runFollowup = async () => {
      attempts += 1;
      if (attempts === 1) {
        markGatewayRestartDraining();
        firstFailed.resolve();
        throw new GatewayDrainingError();
      }
    };

    try {
      enqueueFollowupRun(key, createRun({ prompt: "queued during restart" }), settings);
      scheduleFollowupDrain(key, runFollowup);
      await firstFailed.promise;
      await vi.waitFor(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
      expect(attempts).toBe(1);
      expect(getExistingFollowupQueue(key)).toBeUndefined();
    } finally {
      clearSessionQueues([key]);
      resetGatewayWorkAdmission();
    }
  });

  it("does not replay a selected turn after a draining error", async () => {
    resetGatewayWorkAdmission();
    const key = `test-draining-error-with-open-admission-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const delivered = createDeferred();
    let attempts = 0;
    const abandoned = vi.fn();

    const runFollowup = async () => {
      attempts += 1;
      if (attempts === 1) {
        delivered.resolve();
        throw new GatewayDrainingError();
      }
      delivered.resolve();
    };

    try {
      const source = createRun({ prompt: "retry while admission is open" });
      source.turnAdoptionLifecycle = { onAdopted: async () => {}, onAbandoned: abandoned };
      enqueueFollowupRun(key, source, settings);
      scheduleFollowupDrain(key, runFollowup);
      await delivered.promise;
      await vi.waitFor(() => {
        expect(getExistingFollowupQueue(key)).toBeUndefined();
      });
      expect(attempts).toBe(1);
      expect(abandoned).not.toHaveBeenCalled();
    } finally {
      clearSessionQueues([key]);
      resetGatewayWorkAdmission();
    }
  });

  it("does not reschedule when a restart-signal fence commits to drain", async () => {
    const firstFailed =
      createDeferred<NonNullable<ReturnType<typeof beginGatewayRestartSignalAdmission>>>();
    let attempts = 0;

    const runFollowup = async () => {
      attempts += 1;
      if (attempts === 1) {
        const signal = beginGatewayRestartSignalAdmission();
        if (!signal) {
          throw new Error("expected restart-signal fence");
        }
        firstFailed.resolve(signal);
        throw new GatewayDrainingError();
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "queued during restart commit" }), defaults);
    scheduleFollowupDrain(key, runFollowup);
    await firstFailed.promise;
    markGatewayRestartDraining();
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(attempts).toBe(1);
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  });

  it("resumes a queued followup after a restart-signal fence rolls back", async () => {
    resetGatewayWorkAdmission();
    const key = "test-restart-signal-rollback";
    const run = createRun({ prompt: "queued during pending restart" });
    enqueueFollowupRun(key, run, { mode: "followup", debounceMs: 0, cap: 50 });
    const signal = beginGatewayRestartSignalAdmission();
    if (!signal) {
      throw new Error("expected restart-signal fence");
    }

    const delivered = createDeferred();
    const execute = vi.fn(async () => {
      delivered.resolve();
    });
    try {
      scheduleFollowupDrain(key, execute);
      expect(execute).not.toHaveBeenCalled();
      expect(getExistingFollowupQueue(key)?.items).toEqual([run]);
      expect(signal.rollback()).toBe(true);
      await delivered.promise;
      await run.controllerInput!.settlement.promise;
      await run.controllerInput!.claim?.settlement.promise;
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(execute).toHaveBeenCalledOnce();
      expect(getExistingFollowupQueue(key)).toBeUndefined();
    } finally {
      signal.rollback();
      clearSessionQueues([key]);
      resetGatewayWorkAdmission();
    }
  });

  it.each([
    [true, "external_user", true],
    [true, "inter_session", false],
    [true, "internal_system", false],
    [false, "external_user", false],
  ] as const)(
    "preserves overflow summaries and human ownership for %s/%s",
    async (senderIsOwner, kind, owner) => {
      const key = `test-deferred-summary-retry-${Date.now()}`;
      const prompts: string[] = [];
      const followups: FollowupRun[] = [];
      const inputProvenance = { kind, sourceTool: "test" };
      const settings: QueueSettings = {
        mode: "followup",
        debounceMs: 0,
        cap: 1,
        dropPolicy: "summarize",
      };
      const retried = createDeferred();
      let attempts = 0;

      const runFollowup = async (run: FollowupRun) => {
        attempts++;
        prompts.push(run.prompt);
        followups.push(run);
        if (attempts < 2) {
          return;
        }
        retried.resolve();
      };

      for (const prompt of ["dropped while busy", "kept while busy"]) {
        const followup = createRun({ prompt });
        followup.run.senderIsOwner = senderIsOwner;
        followup.run.inputProvenance = inputProvenance;
        enqueueFollowupRun(key, followup, settings);
      }
      scheduleFollowupDrain(key, runFollowup);

      await retried.promise;

      expect(attempts).toBe(2);
      for (const run of followups.slice(0, 1)) {
        expect(run).toMatchObject({
          run: { senderIsOwner, inputProvenance },
          userTurnTranscriptRecorder: {
            message: { provenance: inputProvenance, __openclaw: { senderIsOwner: owner } },
          },
        });
      }
      expect(prompts[0]).toContain("Dropped 1 message");
      expect(prompts[0]).toContain("dropped while busy");
      expect(prompts[1]).toBe("kept while busy");
    },
  );

  it.each([
    [true, "external_user", true],
    [true, "inter_session", false],
    [true, "internal_system", false],
    [false, "external_user", false],
  ] as const)("keeps collected human ownership for %s/%s", async (senderIsOwner, kind, owner) => {
    const key = `test-collected-human-owner-${Date.now()}`;
    const inputProvenance = { kind, sourceTool: "test" };
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const collected = createDeferred<FollowupRun>();
    for (const prompt of ["first", "second"]) {
      const followup = createRun({ prompt });
      followup.run.senderIsOwner = senderIsOwner;
      followup.run.inputProvenance = inputProvenance;
      followup.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
        input: { text: prompt, senderIsOwner, provenance: inputProvenance },
        target: {
          agentId: followup.run.agentId,
          sessionId: followup.run.sessionId,
          sessionKey: key,
          sessionEntry: undefined,
        },
      });
      enqueueFollowupRun(key, followup, settings);
    }
    scheduleFollowupDrain(key, async (run) => collected.resolve(run));
    const followup = await collected.promise;
    expect(followup.run.senderIsOwner).toBe(senderIsOwner);
    for (const message of [
      followup.userTurnTranscriptRecorder?.message,
      await followup.userTurnTranscriptRecorder?.resolveMessage(),
    ]) {
      expect(message).toMatchObject({
        provenance: inputProvenance,
        __openclaw: { senderIsOwner: owner },
      });
    }
  });

  it.each(["old", "new"] as const)(
    "drains a pending overflow summary after future drops switch to %s",
    async (dropPolicy) => {
      const summarizeSettings: QueueSettings = {
        mode: "followup",
        debounceMs: 0,
        cap: 1,
        dropPolicy: "summarize",
      };
      const nonOutcomeAbandoned = vi.fn();
      const nonOutcomeDisposition = vi.fn();
      const nonOutcomeSettled = vi.fn();
      const createRecordedNonOutcome = (prompt: string) => {
        const run = createRun({ prompt });
        run.onQueueDisposition = nonOutcomeDisposition;
        run.turnAdoptionLifecycle = {
          admission: "cancel-only",
          onAdopted: vi.fn(),
          onAbandoned: nonOutcomeAbandoned,
          onSettled: nonOutcomeSettled,
        };
        return run;
      };
      const first = createRun({ prompt: "first overflowed message" });
      const second =
        dropPolicy === "old"
          ? createRecordedNonOutcome("second queued message")
          : createRun({ prompt: "second queued message" });
      const third =
        dropPolicy === "new"
          ? createRecordedNonOutcome("third rejected message")
          : createRun({ prompt: "third queued message" });
      const deliveredPrompts: string[] = [];
      let forcedCleanup = false;
      let timerFired = false;

      expect(enqueueFollowupRun(key, first, summarizeSettings)).toBe(true);
      expect(enqueueFollowupRun(key, second, summarizeSettings)).toBe(true);
      const queue = getExistingFollowupQueue(key);
      expect(queue).toMatchObject({
        dropPolicy: "summarize",
        droppedCount: 1,
        summaryLines: ["first overflowed message"],
      });
      expect(queue?.summarySources).toEqual([first]);
      expect(queue?.items).toEqual([second]);

      const admitted = enqueueFollowupRun(key, third, {
        ...summarizeSettings,
        dropPolicy,
      });
      expect(admitted).toBe(dropPolicy === "old");
      expect(getExistingFollowupQueue(key)).toBe(queue);
      expect(queue).toMatchObject({
        dropPolicy,
        droppedCount: 1,
        summaryLines: ["first overflowed message"],
      });
      expect(queue?.summarySources).toEqual([first]);
      expect(queue?.items).toEqual([dropPolicy === "old" ? third : second]);

      const timer = new Promise<void>((resolve) => {
        setTimeout(() => {
          timerFired = true;
          resolve();
        }, 0);
      });
      scheduleFollowupDrain(key, async (run) => {
        deliveredPrompts.push(run.prompt);
      });

      for (let pass = 0; pass < 2_000 && getExistingFollowupQueue(key); pass += 1) {
        await Promise.resolve();
      }
      if (getExistingFollowupQueue(key)) {
        forcedCleanup = true;
        clearFollowupQueue(key);
      }
      await timer;
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

      expect(forcedCleanup).toBe(false);
      expect(timerFired).toBe(true);
      expect(deliveredPrompts).toHaveLength(2);
      expect(deliveredPrompts[0]).toContain("[Queue overflow] Dropped 1 message due to cap.");
      expect(deliveredPrompts[0]).toContain("first overflowed message");
      expect(deliveredPrompts[1]).toBe(
        dropPolicy === "old" ? "third queued message" : "second queued message",
      );
      expect(nonOutcomeDisposition).toHaveBeenCalledWith(`queue-cap-${dropPolicy}`);
      expect(nonOutcomeAbandoned).toHaveBeenCalledOnce();
      expect(nonOutcomeSettled).toHaveBeenCalledTimes(1);
      expect(getExistingFollowupQueue(key)).toBeUndefined();
    },
  );

  it("retires queued followups and callbacks when one-way restart drain begins", async () => {
    const abandoned = vi.fn();
    const settled = vi.fn();
    const staleCalls: FollowupRun[] = [];
    const queued = createRun({ prompt: "retire on lifecycle restart" });
    queued.turnAdoptionLifecycle = {
      admission: "cancel-only",
      onAdopted: async () => {},
      onAbandoned: abandoned,
      onSettled: settled,
    };

    enqueueFollowupRun(
      key,
      queued,
      defaults,
      "message-id",
      async (run) => {
        staleCalls.push(run);
      },
      false,
    );
    expect(getExistingFollowupQueue(key)?.items).toEqual([queued]);

    markGatewayRestartDraining();
    await queued.controllerInput!.settlement.promise;

    expect(getExistingFollowupQueue(key)).toBeUndefined();
    expect(abandoned).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
    resetGatewayWorkAdmission();
    enqueueFollowupRun(key, createRun({ prompt: "fresh lifecycle" }), defaults);
    await nextTurn();
    expect(staleCalls).toHaveLength(0);
    expect(getExistingFollowupQueue(key)?.items).toHaveLength(1);
  });
  it("cancels the input of a claimed turn that begins restart drain itself", async () => {
    const input = reserveSessionControllerSource(key, { policy: defaults });
    // Registering a drain callback binds the restart-drain listener under test.
    rememberFollowupDrainCallback(key, async () => {});
    const claim = tryClaimSessionControllerTask(input);
    if (!claim) {
      throw new Error("expected turn claim");
    }
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: "restarting-session",
      resetTriggered: false,
      mailboxClaim: claim,
      upstreamAbortSignal: claim.abortController.signal,
    });
    try {
      // Restart is process-wide; the turn whose tool emitted it gets no exemption.
      withSessionControllerOwner(operation, () => markGatewayRestartDraining());
      expect(input.abortSignal.aborted).toBe(true);
    } finally {
      operation.complete();
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    }
  });
  it.each([
    { mode: "collect", kind: "external_user", senderIsOwner: true, owner: true },
    { mode: "collect", kind: "inter_session", senderIsOwner: true, owner: false },
    { mode: "collect", kind: "external_user", senderIsOwner: false, owner: false },
    { mode: "followup", kind: "external_user", senderIsOwner: true, owner: true },
    { mode: "followup", kind: "inter_session", senderIsOwner: true, owner: false },
    { mode: "followup", kind: "external_user", senderIsOwner: false, owner: false },
  ] as const)(
    "preserves trusted owner provenance for $mode/$kind/$senderIsOwner",
    async ({ mode, kind, senderIsOwner, owner }) => {
      const inputProvenance = { kind, sourceTool: "test" };
      const settings: QueueSettings = {
        mode,
        debounceMs: 0,
        cap: mode === "collect" ? 50 : 1,
        dropPolicy: "summarize",
      };
      const firstDelivery = createDeferred<FollowupRun>();
      const retried = createDeferred<FollowupRun>();
      let attempts = 0;
      for (const prompt of ["first", "second"]) {
        const run = createRun({ prompt });
        run.run.senderIsOwner = senderIsOwner;
        run.run.inputProvenance = inputProvenance;
        run.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
          input: { text: prompt, senderIsOwner, provenance: inputProvenance },
          target: {
            agentId: run.run.agentId,
            sessionId: run.run.sessionId,
            sessionKey: key,
            sessionEntry: undefined,
          },
        });
        enqueueFollowupRun(key, run, settings);
      }
      scheduleFollowupDrain(key, async (run) => {
        attempts += 1;
        if (attempts === 1) {
          firstDelivery.resolve(run);
          if (mode === "followup") {
            run.controllerClaim!.retryBeforeExecution = true;
            throw new Error("reply lane busy");
          }
        } else {
          retried.resolve(run);
        }
      });
      const deliveries = [await firstDelivery.promise];
      if (mode === "followup") {
        deliveries.push(await retried.promise);
      }
      for (const run of deliveries) {
        expect(run.prompt).toContain(
          mode === "collect" ? "[Queued messages while agent was busy]" : "[Queue overflow]",
        );
        expect(run.run).toMatchObject({ senderIsOwner, inputProvenance });
        for (const message of [
          run.userTurnTranscriptRecorder?.message,
          await run.userTurnTranscriptRecorder?.resolveMessage(),
        ]) {
          expect(message).toMatchObject({
            provenance: inputProvenance,
            __openclaw: { senderIsOwner: owner },
          });
        }
      }
    },
  );
});
