import { describe, expect, it, vi } from "vitest";
import { BrowserProfileUnavailableError } from "../errors.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import "../../test-support/browser-security.mock.js";
import { handleRouteError, resolveRouteTabUrl, withRouteTabContext } from "./agent.shared.js";
import { createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

function requestWithBody(body: unknown): BrowserRequest {
  return {
    params: {},
    query: {},
    body,
  };
}

function profileContext(tabs: Array<{ targetId: string; url: string }>) {
  return {
    profile: {
      cdpIsLoopback: true,
      driver: "openclaw",
    },
    listTabs: async () => tabs,
  };
}

function routeContextForTab(
  url: string,
  ensureTabAvailable = vi.fn(async () => ({
    targetId: "tab-1",
    title: "Tab",
    url,
    type: "page",
  })),
): BrowserRouteContext {
  const profileCtx = {
    profile: {
      cdpUrl: "http://127.0.0.1:9222",
      name: "default",
    },
    ensureTabAvailable,
  } as unknown as ProfileContext;

  return {
    forProfile: () => profileCtx,
    state: () => ({
      resolved: {
        actionTimeoutMs: 60_000,
      },
    }),
  } as unknown as BrowserRouteContext;
}

describe("browser route shared helpers", () => {
  it("does not interact after dashboard ownership changes during target resolution", async () => {
    let ownerCurrent = true;
    const ctx = routeContextForTab(
      "https://example.com",
      vi.fn(async () => {
        ownerCurrent = false;
        return { targetId: "tab-1", title: "Tab", url: "https://example.com", type: "page" };
      }),
    );
    const response = createBrowserRouteResponse();
    const run = vi.fn(async () => "mutated");
    await withRouteTabContext({
      req: {
        params: {},
        query: {},
        assertCurrent: async () => {
          if (!ownerCurrent) {
            throw new Error("dashboard was removed");
          }
        },
      },
      res: response.res,
      ctx,
      targetId: "tab-1",
      run,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("dashboard was removed"),
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("preserves structured browser errors on agent routes", () => {
    const response = createBrowserRouteResponse();
    const error = new BrowserProfileUnavailableError("display required", {
      metadata: {
        reason: "no_display_for_headed_profile",
        details: {
          profile: "openclaw",
          requestedHeadless: false,
          headlessSource: "env",
          displayPresent: false,
        },
      },
    });

    handleRouteError(response.res, error);

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      error: "display required",
      reason: "no_display_for_headed_profile",
      details: { headlessSource: "env" },
    });
  });

  it("redacts credentials from unmapped route errors", () => {
    const response = createBrowserRouteResponse();
    const error = new Error(
      "connect failed for wss://browser-user:browser-password@browserless.example/cdp?token=browser-token",
    );

    handleRouteError(response.res, error);

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ error: expect.stringContaining("browserless.example") });
    expect(JSON.stringify(response.body)).not.toContain("browser-user");
    expect(JSON.stringify(response.body)).not.toContain("browser-password");
    expect(JSON.stringify(response.body)).not.toContain("browser-token");
  });

  describe("route tab URLs", () => {
    it("falls back to the ensured tab URL when tab listing is stale", async () => {
      await expect(
        resolveRouteTabUrl({
          profileCtx: profileContext([]) as never,
          targetId: "tab-1",
          fallbackUrl: "https://example.com/fallback",
        }),
      ).resolves.toBe("https://example.com/fallback");
    });

    it("returns private page URLs without endpoint policy checks", async () => {
      await expect(
        resolveRouteTabUrl({
          profileCtx: profileContext([
            { targetId: "tab-1", url: "http://127.0.0.1:8080/admin" },
          ]) as never,
          targetId: "tab-1",
        }),
      ).resolves.toBe("http://127.0.0.1:8080/admin");
    });

    it("propagates cancellation during tab listing", async () => {
      const controller = new AbortController();
      const reason = new Error("browser request cancelled");
      await expect(
        resolveRouteTabUrl({
          profileCtx: {
            listTabs: async () => {
              controller.abort(reason);
              throw reason;
            },
          } as never,
          targetId: "tab-1",
          signal: controller.signal,
          fallbackUrl: "https://example.com/fallback",
        }),
      ).rejects.toBe(reason);
    });
  });

  describe("withRouteTabContext", () => {
    it("runs agent operations on private page URLs", async () => {
      const response = createBrowserRouteResponse();
      const run = vi.fn(async () => {
        response.res.json({ ok: true });
      });

      await withRouteTabContext({
        req: requestWithBody({}),
        res: response.res,
        ctx: routeContextForTab("http://127.0.0.1:8080/admin"),
        run,
      });

      expect(run).toHaveBeenCalledOnce();
      expect(response.body).toEqual({ ok: true });
    });
  });
});
