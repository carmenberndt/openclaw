import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { restartRunningChannelAccounts } from "./channel-thaw-restart.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createChannelManager } from "./server-channels.js";
import {
  createTestPlugin,
  createTestChannelManager,
  createTestChannelRegistry,
  waitForAbort,
  type TestAccount,
} from "./server-channels.test-support.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

vi.mock("../infra/approval-handler-bootstrap.js", () => ({
  startChannelApprovalHandlerBootstrap: async () => async () => {},
}));

beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  resetGatewayWorkAdmission();
});

it("keeps thaw-restarted channel work alive after the maintenance tick finishes", async () => {
  const inbound = createDeferred();
  const reply = createDeferred<string>();
  const initialStarted = createDeferred<AbortSignal>();
  const replacementStarted = createDeferred<AbortSignal>();
  let starts = 0;
  const plugin = createTestPlugin({
    startAccount: async ({ abortSignal }) => {
      if (++starts === 1) {
        initialStarted.resolve(abortSignal);
      } else {
        replacementStarted.resolve(abortSignal);
        await inbound.promise;
        reply.resolve(trackAsyncWork(async () => "reply"));
      }
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  const registry = createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]);
  const previousRegistry = getActivePluginRegistry();
  setActivePluginRegistry(registry);
  const log = createSubsystemLogger("gateway/channel-work-scope-test");
  const manager = createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig: () => ({}),
    getPluginRegistry: () => registry,
    channelLogs: { discord: log },
    channelRuntimeEnvs: { discord: runtimeForLogger(log) },
  });
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const errors: string[] = [];
  let maintenanceSignal: AbortSignal | undefined;

  try {
    await manager.startChannels();
    const originalSignal = await initialStarted.promise;
    scheduler.schedule({
      id: "maintenance:host-thaw",
      delayMs: 0,
      run: async () => {
        maintenanceSignal = getAsyncWorkSignal();
        await restartRunningChannelAccounts(manager, {
          shouldContinue: () => true,
          onError: (message) => errors.push(message),
        });
      },
    });
    await clock.wake();
    expect(errors).toEqual([]);
    const replacementSignal = await replacementStarted.promise;
    expect(maintenanceSignal?.aborted).toBe(true);
    expect(originalSignal.aborted).toBe(true);
    expect(replacementSignal.aborted).toBe(false);

    inbound.resolve();
    await expect(reply.promise).resolves.toBe("reply");
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.default?.running).toBe(true);
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(replacementSignal.aborted).toBe(true);
  } finally {
    inbound.resolve();
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await scheduler.stop();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  }
});

it("keeps channel requests bound to their Gateway after the starting client closes", async () => {
  const continueChannelRequest = createDeferred();
  const observedGateway = createDeferred<{ gateway: string }>();
  const ownerContext = createContext();
  ownerContext.getGatewayMethodRegistry = () =>
    createGatewayMethodRegistry([
      {
        name: "health",
        scope: "operator.read",
        owner: { kind: "core", area: "channel-startup" },
        handler: ({ respond }: GatewayRequestHandlerOptions) =>
          respond(true, { gateway: "channel-owner" }),
      },
    ]);
  const callerContext = createContext();
  callerContext.getGatewayMethodRegistry = () =>
    createGatewayMethodRegistry([
      {
        name: "health",
        scope: "operator.read",
        owner: { kind: "core", area: "channel-startup" },
        handler: ({ respond }: GatewayRequestHandlerOptions) =>
          respond(true, { gateway: "starting-client" }),
      },
    ]);
  const startAccount = async ({ abortSignal }: ChannelGatewayContext<TestAccount>) => {
    await continueChannelRequest.promise;
    try {
      observedGateway.resolve(
        await dispatchGatewayMethodInProcess<{ gateway: string }>(
          "health",
          {},
          {
            syntheticScopes: ["operator.read"],
            operatorRoleActor: { kind: "system" },
          },
        ),
      );
    } catch (error) {
      observedGateway.reject(error);
    }
    await waitForAbort(abortSignal);
  };
  const registry = createTestChannelRegistry(createTestPlugin({ startAccount }));
  const manager = createTestChannelManager({
    getPluginRegistry: () => registry,
    resolveGatewayContext: () => ownerContext,
  });
  const callerLifetime = new AbortController();

  try {
    await withPluginRuntimeGatewayRequestScope(
      {
        context: callerContext,
        client: createSyntheticPluginRuntimeClient({
          scopes: ["operator.read"],
          operatorRoleActor: { kind: "system" },
        }),
        isWebchatConnect: () => false,
        signal: callerLifetime.signal,
        hasCurrentClientAuthority: () => !callerLifetime.signal.aborted,
      },
      () => manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true }),
    );
    callerLifetime.abort();
    const requestResult = expect(observedGateway.promise).resolves.toEqual({
      gateway: "channel-owner",
    });
    continueChannelRequest.resolve();
    await requestResult;
  } finally {
    continueChannelRequest.resolve();
    await manager.stopChannel("discord");
  }
});
