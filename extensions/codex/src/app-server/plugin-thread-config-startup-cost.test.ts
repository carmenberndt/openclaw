// Regression coverage for plugin discovery work within one startup budget.
import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import {
  appInfo,
  appSummary,
  pluginDetail,
  pluginInstalled,
  pluginList,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { createCodexPluginThreadConfigStartupProvider } from "./plugin-thread-config-deadline.js";
import { buildCodexPluginThreadConfig } from "./plugin-thread-config.js";
import type { CodexAppServerRequestParams } from "./protocol.js";

const pluginConfig = {
  codexPlugins: {
    enabled: true,
    plugins: {
      "google-calendar": {
        marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
        pluginName: "google-calendar",
      },
    },
  },
};

describe("Codex plugin startup metadata", () => {
  it("keeps healthy plugin apps available when cold manifest discovery fits the startup budget", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      const plugins = [pluginSummary("google-calendar", { installed: true, enabled: true })];
      if (method === "plugin/installed") {
        return pluginInstalled(plugins);
      }
      if (method === "plugin/list") {
        return pluginList(plugins);
      }
      if (method === "plugin/read") {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 35_000);
        });
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(
          method,
          [appInfo("google-calendar-app", true)],
          params as CodexAppServerRequestParams<typeof method>,
        );
      }
      throw new Error(`unexpected request ${method}`);
    });
    try {
      const pending = createCodexPluginThreadConfigStartupProvider({
        inputFingerprint: undefined,
        enabledPluginConfigKeys: undefined,
        policy: undefined,
        requestTimeoutMs: 240_000,
        signal: new AbortController().signal,
        pluginConfig,
        appCache: new CodexAppInventoryCache(),
        appCacheKey: "runtime-slow-manifest",
        metadataCache: new CodexPluginMetadataCache(),
        client: { request },
      }).build();

      await vi.advanceTimersByTimeAsync(60_000);
      const config = await pending;
      expect(config.diagnostics).toEqual([]);
      expect(config.configPatch?.apps).toMatchObject({
        _default: { enabled: false },
        "google-calendar-app": { enabled: true },
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rereads changed plugin ownership on a later startup", async () => {
    let appId = "first-calendar-app";
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      const plugins = [pluginSummary("google-calendar", { installed: true, enabled: true })];
      if (method === "plugin/installed") {
        return pluginInstalled(plugins);
      }
      if (method === "plugin/list") {
        return pluginList(plugins);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary(appId)]);
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(
          method,
          [appInfo("first-calendar-app", true), appInfo("second-calendar-app", true)],
          params as CodexAppServerRequestParams<typeof method>,
        );
      }
      throw new Error(`unexpected request ${method}`);
    });
    const params = {
      pluginConfig,
      appCache: new CodexAppInventoryCache(),
      appCacheKey: "runtime-changing-manifest",
      request,
    };
    const first = await buildCodexPluginThreadConfig(params);
    appId = "second-calendar-app";
    const second = await buildCodexPluginThreadConfig(params);

    expect(Object.keys(first.policyContext.apps)).toEqual(["first-calendar-app"]);
    expect(Object.keys(second.policyContext.apps)).toEqual(["second-calendar-app"]);
  });
});
