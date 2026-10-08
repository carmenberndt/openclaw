import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { withPluginRetentionOwner } from "../../plugins/plugin-retention-diagnostics.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  captureActivePluginRegistrySnapshot,
  createPluginRegistryOwner,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

const inspectManagedPlugin = vi.hoisted(() => vi.fn());
// mock-isolation: Inventory I/O must not load installed plugins or operator state.
vi.mock("../../plugins/management-service.js", () => ({
  inspectManagedPlugin,
  listManagedPlugins: vi.fn(),
}));

const { pluginsHandlers } = await import("./plugins.js");
const inspection = { plugin: { id: "retained-plugin", installed: true, enabled: true } };
const acquisitionOwner = {
  agentId: "fixture",
  sessionKey: "private-session",
  runId: "private-run",
};

// Use accepted handshake facts without creating a transport or starting a Gateway.
function adminClient(): GatewayClient {
  return {
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "test", version: "test", platform: "test", mode: "test" },
      role: "operator",
      scopes: ["operator.admin"],
    },
  };
}

// Real instances retain host work; no plugin module needs to be evaluated.
function retainedPlugin(registry = createEmptyPluginRegistry(), id = inspection.plugin.id) {
  const record = createPluginRecord({ id });
  registry.plugins.push(record);
  const instance = new PluginInstance(id, { record, registry });
  const release = withPluginRetentionOwner(acquisitionOwner, () =>
    instance.retainWork("prepared-generation-lease"),
  );
  const run = vi.spyOn(instance, "run");
  return { registry, instance, release, run };
}

// Exercise validation, async inventory, scope selection, and response composition together.
async function inspect(
  registry: PluginRegistry,
  overrides: Partial<GatewayRequestHandlerOptions> = {},
) {
  const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
  const params = overrides.params ?? { pluginId: inspection.plugin.id };
  await withPluginRuntimeGatewayRequestScope(
    { pluginRegistry: registry, isWebchatConnect: () => false },
    () =>
      expectDefined(
        pluginsHandlers["plugins.inspect"],
        "plugins.inspect handler",
      )({
        req: { type: "req", id: "retention-inspection", method: "plugins.inspect", params },
        params,
        client: adminClient(),
        isWebchatConnect: () => false,
        context: { getRuntimeConfig: () => ({}) } as GatewayRequestHandlerOptions["context"],
        ...overrides,
        respond,
      }),
  );
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, expect.any(Object), undefined);
  return respond.mock.calls[0]![1];
}

beforeEach(() => inspectManagedPlugin.mockReset().mockResolvedValue(inspection));
afterEach(() => vi.restoreAllMocks());

describe("plugins.inspect runtime retention disclosure", () => {
  it.each([{ pluginId: inspection.plugin.id }, { catalogId: "local_cmV0YWluZWQtcGx1Z2lu" }])(
    "shows current local references and removes released acquisitions for %j",
    async (params) => {
      const fixture = retainedPlugin();
      try {
        const response = await inspect(fixture.registry, {
          params,
          hasCurrentClientAuthority: () => true,
        });
        expect(response).toMatchObject({
          ...inspection,
          runtimeRetention: {
            pluginId: inspection.plugin.id,
            total: 1,
            omitted: 0,
            references: [
              { kind: "work", reason: "prepared-generation-lease", owner: acquisitionOwner },
            ],
          },
        });
        fixture.release();
        expect(await inspect(fixture.registry, { params })).toMatchObject({
          runtimeRetention: { total: 0, omitted: 0, references: [] },
        });
        expect(fixture.run).not.toHaveBeenCalled();
      } finally {
        fixture.release();
        await fixture.instance.dispose();
      }
    },
  );

  it.each(["missing record", "record without instance"])(
    "returns null instead of inspecting another instance: %s",
    async (state) => {
      const fixture = retainedPlugin(createEmptyPluginRegistry(), "different-plugin");
      if (state === "record without instance") {
        fixture.registry.plugins.push(createPluginRecord({ id: inspection.plugin.id }));
      }
      try {
        expect(await inspect(fixture.registry)).toMatchObject({ runtimeRetention: null });
        expect(fixture.run).not.toHaveBeenCalled();
      } finally {
        fixture.release();
        await fixture.instance.dispose();
      }
    },
  );

  it.each(["no client", "read-only operator", "remote package", "remote catalog identity"])(
    "omits cross-session diagnostics for %s",
    async (visibility) => {
      const fixture = retainedPlugin();
      const client = adminClient();
      if (visibility === "read-only operator") {
        client.connect.scopes = ["operator.read"];
      }
      const params =
        visibility === "remote package"
          ? { source: "clawhub", packageName: "community/plugin" }
          : visibility === "remote catalog identity"
            ? { catalogId: "ch_Y29tbXVuaXR5L3BsdWdpbg" }
            : { pluginId: inspection.plugin.id };
      try {
        const response = await inspect(fixture.registry, {
          params,
          client: visibility === "no client" ? null : client,
        });
        expect(response).toEqual({ ...inspection, decisions: [] });
        expect(JSON.stringify(response)).not.toMatch(/private-session|private-run/);
        expect(fixture.run).not.toHaveBeenCalled();
      } finally {
        fixture.release();
        await fixture.instance.dispose();
      }
    },
  );

  it.each([
    "scope removed",
    "invalidated",
    "connection aborted",
    "request aborted",
    "authority revoked",
  ])("rechecks authority after deferred inventory: %s", async (revocation) => {
    const fixture = retainedPlugin();
    const entered = createDeferredCore();
    const catalog = createDeferredCore<typeof inspection>();
    inspectManagedPlugin.mockImplementationOnce(() => {
      entered.resolve();
      return catalog.promise;
    });
    const client = adminClient();
    const connection = new AbortController();
    const request = new AbortController();
    client.connectionSignal = connection.signal;
    let current = true;
    const hasCurrentClientAuthority = vi.fn(() => current);
    const pending = inspect(fixture.registry, {
      client,
      signal: request.signal,
      hasCurrentClientAuthority,
    });
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "inspection skipped inventory");
      // Revoke exactly one live capability while catalog metadata is still in flight.
      if (revocation === "scope removed") {
        client.connect.scopes = ["operator.read"];
      }
      if (revocation === "invalidated") {
        client.invalidated = true;
      }
      if (revocation === "connection aborted") {
        connection.abort();
      }
      if (revocation === "request aborted") {
        request.abort();
      }
      if (revocation === "authority revoked") {
        current = false;
      }
      catalog.resolve(inspection);
      expect(await pending).toEqual({ ...inspection, decisions: [] });
      if (revocation === "authority revoked") {
        expect(hasCurrentClientAuthority).toHaveReturnedWith(false);
      }
      expect(fixture.run).not.toHaveBeenCalled();
    } finally {
      catalog.resolve(inspection);
      await Promise.allSettled([pending]);
      fixture.release();
      await fixture.instance.dispose();
    }
  });

  it("uses the request registry after another Gateway publishes during inventory", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const previous = captureActivePluginRegistrySnapshot();
      const request = retainedPlugin();
      const unrelated = retainedPlugin();
      const requestOwner = createPluginRegistryOwner(request.registry);
      const unrelatedOwner = createPluginRegistryOwner(unrelated.registry);
      const entered = createDeferredCore();
      const catalog = createDeferredCore<typeof inspection>();
      inspectManagedPlugin.mockImplementationOnce(() => {
        entered.resolve();
        return catalog.promise;
      });
      setActivePluginRegistry(request.registry);
      const pending = inspect(requestOwner.registry);
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "inspection skipped inventory");
        // A colliding ID in the process projection cannot replace this request's owner.
        setActivePluginRegistry(unrelated.registry);
        unrelated.release();
        catalog.resolve(inspection);
        expect(await pending).toMatchObject({
          runtimeRetention: {
            pluginId: inspection.plugin.id,
            total: 1,
            references: [{ owner: acquisitionOwner }],
          },
        });
        expect(request.run).not.toHaveBeenCalled();
        expect(unrelated.run).not.toHaveBeenCalled();
      } finally {
        catalog.resolve(inspection);
        await Promise.allSettled([pending]);
        request.release();
        unrelated.release();
        try {
          await Promise.all([requestOwner.close(), unrelatedOwner.close()]);
        } finally {
          restoreActivePluginRegistrySnapshot(previous);
        }
      }
    });
  });
});
