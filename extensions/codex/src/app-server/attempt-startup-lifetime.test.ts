import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { nativeHookRelayTesting } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerInitialize,
  createAttemptPaths,
  createAttemptClientHarness,
  createAttemptThreadStarter,
  readHarnessMessages,
  readHarnessRequestMethods,
  waitForRequest,
  waitForThreadStart,
} from "./attempt-startup.test-support.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult as createThreadStartResult } from "./codex-app-server.test-fixtures.js";
import { type CodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./config.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import * as runAttemptResources from "./run-attempt-resources.js";
import {
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";
import * as sandboxExecServer from "./sandbox-exec-server.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import * as sharedClient from "./shared-client.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createInferenceReadyClientHarness } from "./test-support.js";

vi.mock("./desktop-generation.js", () => ({
  isCodexDesktopGenerationCurrent: () => false,
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();
const pluginConfig: CodexPluginConfig = { appServer: { command: "codex" } };
const startThreadWithHarness = createAttemptThreadStarter(tempRoots, pluginConfig);
const threadStartResult = (threadId = "thread-1") => createThreadStartResult(threadId, "/repo");

describe("startup cancellation with a healthy peer and replacement attempt", () => {
  beforeEach(async () => {
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(undefined);
    defaultCodexPluginMetadataCache.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it("retires indeterminate thread startup while another leased peer completes", async () => {
    const threadWritten = createDeferred<{ id: number }>();
    const retained = createInferenceReadyClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line) as { id: number; method: string };
        if (request.method === "configRequirements/read") {
          send({ id: request.id, result: { requirements: null } });
        } else if (request.method === "thread/start") {
          threadWritten.resolve(request);
        }
      },
    });
    const replacement = createAttemptClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(retained.client)
      .mockResolvedValueOnce(replacement.client);
    const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
    const paths = createAttemptPaths(tempRoots);

    const retainedLease = getLeasedSharedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: paths.agentDir,
    });
    await answerInitialize(retained);
    await expect(retainedLease).resolves.toBe(retained.client);

    const peer = retained.client.request("turn/start", { threadId: "healthy-peer" });
    void peer.catch(() => undefined);
    const peerStart = await waitForRequest(retained, "turn/start");
    // Hold the startup clock while real worker admission runs, then expire the
    // same 100-ms budget only after the request has actually crossed the wire.
    vi.useFakeTimers();
    const { run } = startThreadWithHarness(100, new AbortController().signal, {
      harness: retained,
      paths,
      skipStartSpy: true,
    });
    const rejected = expect(run).rejects.toThrow("codex app-server startup timed out");
    const threadStart = await threadWritten.promise;
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    vi.useRealTimers();
    expect(threadStart.id).toBeDefined();
    expect(retained.process.stdin.destroyed).toBe(false);
    const replacementRun = startThreadWithHarness(5_000, new AbortController().signal, {
      harness: replacement,
      paths,
      skipStartSpy: true,
    }).run;
    await answerInitialize(replacement);
    const mutate = vi.spyOn(testCodexAppServerBindingStore, "mutate");
    retained.send({ id: threadStart.id, result: threadStartResult("replacement-thread") });
    retained.send({
      method: "thread/started",
      params: { thread: threadStartResult("replacement-thread").thread },
    });
    const replacementStart = await waitForThreadStart(replacement);
    expect(mutate).not.toHaveBeenCalled();
    replacement.send({ id: replacementStart.id, result: threadStartResult("replacement-thread") });
    const replacementAttempt = await replacementRun;
    const binding = testCodexAppServerBindingStore.read({
      kind: "session",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
    });
    expect(binding?.threadId).toBe("replacement-thread");
    const writesAfterReplacement = mutate.mock.calls.length;
    const tool = vi.fn(() => ({ success: true }));
    await replacementAttempt.turnRoute.activate({ onRequest: tool });
    const toolRequest = {
      method: "item/tool/call",
      params: { threadId: "replacement-thread", turnId: "replacement-turn", tool: "message" },
    };
    retained.send({ id: threadStart.id, result: threadStartResult("replacement-thread") });
    retained.send({
      method: "thread/started",
      params: { thread: threadStartResult("replacement-thread").thread },
    });
    retained.send({ id: "stale-tool", ...toolRequest });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await replacementAttempt.turnRoute.drain();
    expect(tool).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(writesAfterReplacement);
    expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
      }),
    ).toEqual(binding);
    expect(readHarnessRequestMethods(replacement)).not.toContain("thread/unsubscribe");
    expect(readHarnessRequestMethods(replacement)).not.toContain("turn/start");
    // Positive route control: only the authoritative client's tool request runs.
    replacement.send({ id: "current-tool", ...toolRequest });
    await vi.waitFor(() => expect(tool).toHaveBeenCalledTimes(1));
    retained.send({ id: peerStart.id, result: { turn: { id: "healthy-turn" } } });
    await expect(peer).resolves.toEqual({ turn: { id: "healthy-turn" } });
    expect(retained.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(retained.client)).toBe(true);
    expect(retained.process.stdin.destroyed).toBe(true);
    expect(replacement.process.stdin.destroyed).toBe(false);
    replacementAttempt.turnRoute.release();
    replacementAttempt.releaseSharedClientLease();
  });
});

describe("Codex runtime startup resource lifetime", () => {
  setupRunAttemptTestHooks();

  it.each(["capture-failed", "abort", "cleanup", "replacement"] as const)(
    "releases allocated runtime owners once when native monitor setup ends with %s",
    async (ending) => {
      const harness = createStartedThreadHarness();
      const params = createTestParams();
      const abortController = new AbortController();
      params.abortSignal = abortController.signal;
      params.sandbox = createSandboxContext({});
      params.runtimePlan = createCodexRuntimePlanFixture();
      setCodexTestModelSupportsTools(params, true);
      setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("message")]);
      const resourcesSpy = vi.spyOn(runAttemptResources, "prepareCodexAttemptResources");
      const releaseSandbox = vi.spyOn(
        sandboxExecServer,
        "releaseCodexSandboxExecServerEnvironment",
      );
      const allocated: Array<
        ReturnType<typeof runAttemptResources.prepareCodexAttemptResources>["state"]
      > = [];
      const setupError = new Error("native monitor setup failed");
      const captured = createDeferred<void>();
      const releaseCapture = createDeferred<void>();
      const registerMonitor = codexNativeSubagentMonitorRuntime.register;
      let registration: Awaited<ReturnType<typeof registerMonitor>> | undefined;
      const register = vi
        .spyOn(codexNativeSubagentMonitorRuntime, "register")
        .mockImplementationOnce(async (options) => {
          const state = resourcesSpy.mock.results[0]?.value.state;
          assert(state?.turnRoute, "startup must allocate a route before monitor setup");
          assert(
            state.sandboxExecEnvironment,
            "startup must allocate a sandbox before monitor setup",
          );
          assert(state.nativeHookRelay, "startup must allocate a relay before monitor setup");
          assert(
            state.releaseSharedClientLease,
            "startup must allocate a client lease before monitor setup",
          );
          vi.spyOn(state.turnRoute, "release");
          vi.spyOn(state.nativeHookRelay, "unregister");
          vi.spyOn(state.nativeHookRelay, "drain");
          state.releaseSharedClientLease = vi.fn(state.releaseSharedClientLease);
          allocated.push({ ...state });
          if (ending !== "capture-failed") {
            registration = await registerMonitor(options);
            vi.spyOn(registration, "unregister");
          }
          captured.resolve();
          await releaseCapture.promise;
          if (!registration) {
            throw setupError;
          }
          return registration;
        });

      try {
        const run = runCodexAppServerAttempt(params, {
          pluginConfig: { appServer: { mode: "yolo", experimental: { sandboxExecServer: true } } },
          nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
        });
        const rejected =
          ending === "capture-failed" || ending === "abort"
            ? expect(run).rejects.toBe(setupError)
            : expect(run).rejects.toThrow("registration was superseded during setup");
        await captured.promise;
        const resources = resourcesSpy.mock.results[0]?.value;
        assert(resources);
        expect(resources.state.nativeSubagentMonitor).toBeUndefined();
        if (ending === "abort") {
          abortController.abort(setupError);
        } else if (ending === "cleanup") {
          await resources.releaseCurrentRoute();
        } else if (ending === "replacement") {
          resources.state.thread = { ...resources.state.thread };
        }
        releaseCapture.resolve();
        await rejected;
        expect(register).toHaveBeenCalledOnce();
        expect(resources.state.nativeSubagentMonitor).toBeUndefined();
        if (registration) {
          expect(registration.unregister).toHaveBeenCalledOnce();
        }
        const [owners] = allocated;
        assert(owners);
        expect.soft(owners.turnRoute?.release).toHaveBeenCalledOnce();
        expect.soft(owners.releaseSharedClientLease).toHaveBeenCalledOnce();
        expect.soft(owners.nativeHookRelay?.unregister).toHaveBeenCalledOnce();
        expect.soft(owners.nativeHookRelay?.drain).toHaveBeenCalledOnce();
        expect
          .soft(releaseSandbox)
          .toHaveBeenCalledExactlyOnceWith(params.sandbox, owners.sandboxExecEnvironment);
        expect
          .soft(
            nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
              owners.nativeHookRelay!.relayId,
            ),
          )
          .toBeUndefined();
        expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
      } finally {
        releaseCapture.resolve();
        harness.close();
      }
    },
  );
});

describe("startup after the bound shared client was retired", () => {
  beforeEach(async () => {
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(undefined);
    defaultCodexPluginMetadataCache.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it.each(["timeout", "stop"] as const)(
    "ends a predecessor-exit wait on %s without retiring its own client",
    async (ending) => {
      const retired = createAttemptClientHarness();
      const replacement = createAttemptClientHarness();
      vi.spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(retired.client)
        .mockResolvedValueOnce(replacement.client);
      const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
      const paths = createAttemptPaths(tempRoots);

      // Another session's long-running turn leases the same shared client.
      const siblingLease = getLeasedSharedCodexAppServerClient({
        startOptions: appServer.start,
        agentDir: paths.agentDir,
      });
      await answerInitialize(retired);
      await expect(siblingLease).resolves.toBe(retired.client);

      // This session's turn binds its thread to that client.
      const first = startThreadWithHarness(5_000, new AbortController().signal, {
        harness: retired,
        paths,
        skipStartSpy: true,
      });
      const threadStart = await waitForThreadStart(retired);
      retired.send({ id: threadStart.id, result: threadStartResult() });
      const started = await first.run;
      // Cleanup that could not release the subscription retired the client and
      // dropped this attempt's lease; only the sibling keeps it running.
      started.thread.liveThreadOwnership?.forget();
      retireSharedCodexAppServerClientIfCurrent(started.client);
      started.releaseSharedClientLease();
      expect(retired.process.stdin.destroyed).toBe(false);

      // Writer handoff to the retired owner must wait for its exit.
      const exitWaits = [createDeferred<void>(), createDeferred<void>()] as const;
      let retains = 0;
      const retain = sharedClient.retainSharedCodexAppServerClientByInstanceId;
      vi.spyOn(sharedClient, "retainSharedCodexAppServerClientByInstanceId").mockImplementation(
        async (clientId) => {
          const owner = await retain(clientId);
          const waitStarted = exitWaits[retains++];
          assert(waitStarted, "only two startups hand off the retired owner's thread");
          return (
            owner && {
              ...owner,
              release: (waitForRetirement?: boolean) => {
                const exit = owner.release(waitForRetirement);
                if (exit) {
                  waitStarted.resolve();
                }
                return exit;
              },
            }
          );
        },
      );
      const answerThreadRead = async () => {
        const reads = readHarnessMessages(replacement.writes).length;
        await vi.waitFor(
          () =>
            expect(
              readHarnessMessages(replacement.writes.slice(reads)).some(
                ({ method }) => method === "thread/read",
              ),
            ).toBe(true),
          { interval: 1, timeout: 5_000 },
        );
        const read = readHarnessMessages(replacement.writes.slice(reads)).find(
          ({ method }) => method === "thread/read",
        );
        // The retired owner unloaded the thread once this session stopped writing.
        const thread = { ...threadStartResult().thread, status: { type: "notLoaded" } };
        replacement.send({ id: read?.id, result: { thread } });
      };

      const stop = new AbortController();
      const stopThird = new AbortController();
      let third: ReturnType<typeof startThreadWithHarness> | undefined;
      try {
        if (ending === "timeout") {
          vi.useFakeTimers();
        }
        const abandoned = startThreadWithHarness(30_000, stop.signal, {
          harness: replacement,
          paths,
          skipStartSpy: true,
        });
        const failure = abandoned.run.then(
          () => undefined,
          (error: unknown) => error,
        );
        await answerInitialize(replacement);
        await answerThreadRead();
        await exitWaits[0].promise;
        if (ending === "timeout") {
          await vi.advanceTimersByTimeAsync(30_000);
          vi.useRealTimers();
        } else {
          stop.abort("user stop");
        }
        const error = await failure;
        expect(replacement.process.stdin.destroyed).toBe(false);
        expect(error).toMatchObject({
          name: "CodexAppServerStartupError",
          reason: ending === "timeout" ? "timed_out" : "aborted",
          message: expect.stringContaining("previous Codex app-server is still finishing"),
        });
        expect(readHarnessRequestMethods(replacement)).not.toContain("thread/resume");

        // The abandoned startup released the thread queue and binding lease, so the
        // next turn reaches the same exit wait on the same healthy client.
        third = startThreadWithHarness(30_000, stopThird.signal, {
          harness: replacement,
          paths,
          skipStartSpy: true,
        });
        await answerThreadRead();
        await exitWaits[1].promise;
        expect(retired.process.stdin.destroyed).toBe(false);
      } finally {
        vi.useRealTimers();
        expect(releaseLeasedSharedCodexAppServerClient(retired.client)).toBe(true);
      }
      // The predecessor exits once its last sibling lease drains; the handoff proceeds.
      assert(third, "the next startup must have started");
      await vi.waitFor(() => expect(retired.process.stdin.destroyed).toBe(true));
      await waitForRequest(replacement, "thread/resume");
      stopThird.abort("test complete");
      await expect(third.run).rejects.toThrow("codex app-server startup aborted");
    },
  );
});
