// Regression coverage for plugin discovery work within one startup budget.
import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import {
  appInfo,
  appSummary,
  pluginDetail,
  pluginList,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { createCodexPluginThreadConfigStartupProvider } from "./plugin-thread-config-deadline.js";
import { buildCodexPluginThreadConfig } from "./plugin-thread-config.js";

describe("Codex plugin startup metadata", () => {
  it("does not spend the startup budget rereading manifests after loading app inventory", async () => {
    let nowMs = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        nowMs += 35_000;
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    try {
      const config = await createCodexPluginThreadConfigStartupProvider({
        inputFingerprint: undefined,
        enabledPluginConfigKeys: undefined,
        policy: undefined,
        requestTimeoutMs: 240_000,
        signal: new AbortController().signal,
        pluginConfig: {
          codexPlugins: {
            enabled: true,
            plugins: {
              "google-calendar": {
                marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                pluginName: "google-calendar",
              },
            },
          },
        },
        appCache: new CodexAppInventoryCache(),
        appCacheKey: "runtime-slow-manifest",
        metadataCache: new CodexPluginMetadataCache(),
        client: { request },
      }).build();

      expect(config.configPatch?.apps).toMatchObject({
        _default: { enabled: false },
        "google-calendar-app": { enabled: true },
      });
      expect(config.diagnostics).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it("rereads changed plugin ownership on a later startup", async () => {
    let appId = "first-calendar-app";
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary(appId)]);
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [
          appInfo("first-calendar-app", true),
          appInfo("second-calendar-app", true),
        ]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const params = {
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
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
