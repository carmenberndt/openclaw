import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { isRfc1918Ipv4Address } from "@openclaw/net-policy/ip";
import { expectDefined } from "@openclaw/normalization-core";
import express from "express";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from "../bridge-auth-registry.js";
import { browserAct, browserNavigate } from "../client-actions.js";
import { BrowserServiceError } from "../client-fetch.js";
import { browserOpenTab, browserSnapshot, browserTabs } from "../client.js";
import { resolveBrowserConfig } from "../config.js";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "../server-middleware.js";
import { getFreePort } from "../test-port.js";
import { registerBrowserRoutes } from "./index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const privateHost = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .find((address) => address.family === "IPv4" && isRfc1918Ipv4Address(address.address))?.address;

describe.runIf(process.env.OPENCLAW_BROWSER_NAVIGATION_E2E === "1")(
  "Chromium page navigation through the browser client",
  () => {
    let context: BrowserContext;
    let controlServer: Server;
    let fixture: Server;
    let baseUrl: string;
    let controlPort: number;
    let fixturePort: number;
    let cdpUrl: string;
    let privateFixtureReachable = false;
    const requests: string[] = [];
    const serviceToken = randomUUID();

    beforeAll(async () => {
      fixture = createServer((req, res) => {
        const requested = new URL(req.url ?? "/", "http://fixture.invalid");
        requests.push(requested.pathname);
        res.setHeader("Content-Type", "text/html");
        if (requested.pathname === "/protected") {
          const authorized = req.headers.authorization === `Bearer ${serviceToken}`;
          res.statusCode = authorized ? 200 : 401;
          res.end(
            authorized
              ? "<main><h1>Authorized private data</h1></main>"
              : "<main><h1>Authentication required</h1></main>",
          );
          return;
        }
        if (requested.pathname === "/redirect") {
          res.statusCode = 302;
          res.setHeader("Location", "/redirect-destination");
          res.end();
          return;
        }
        if (requested.pathname === "/links") {
          const destination = requested.searchParams.has("batch")
            ? "/batch-destination"
            : "/click-destination";
          res.end(
            `<main><h1>Private links</h1><a href="${destination}">Visit destination</a></main>`,
          );
          return;
        }
        res.end(`<main><h1>Private page ${requested.pathname}</h1></main>`);
      });
      await new Promise<void>((resolve) => {
        fixture.listen(0, "0.0.0.0", resolve);
      });
      const fixtureAddress = fixture.address();
      if (!fixtureAddress || typeof fixtureAddress === "string") {
        throw new Error("Navigation fixture did not bind a TCP port");
      }
      fixturePort = fixtureAddress.port;
      if (privateHost) {
        // An assigned VPN/bridge address need not route back to this fixture.
        // Run the private-network proof only when the fixture is reachable.
        privateFixtureReachable = await fetch(`http://${privateHost}:${fixturePort}/reachability`, {
          signal: AbortSignal.timeout(3_000),
        }).then(
          (response) => response.ok,
          () => false,
        );
      }
      const cdpPort = await getFreePort();
      cdpUrl = `http://127.0.0.1:${cdpPort}`;
      context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-browser-navigation-"), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${cdpPort}`],
        },
      );
      const state: BrowserServerState = {
        port: 0,
        profiles: new Map(),
        resolved: resolveBrowserConfig({
          defaultProfile: "navigation",
          // Owned loopback CDP must work with strict remote endpoint defaults.
          cdpPolicy: {},
          profiles: { navigation: { cdpUrl, color: "#123456" } },
        }),
      };
      const app = express();
      const auth = { token: randomUUID() };
      installBrowserCommonMiddleware(app);
      installBrowserAuthMiddleware(app, auth);
      registerBrowserRoutes(app, createBrowserRouteContext({ getState: () => state }));
      controlServer = createServer(app);
      await new Promise<void>((resolve) => {
        controlServer.listen(0, "127.0.0.1", resolve);
      });
      const controlAddress = controlServer.address();
      if (!controlAddress || typeof controlAddress === "string") {
        throw new Error("Browser control did not bind a TCP port");
      }
      controlPort = controlAddress.port;
      baseUrl = `http://127.0.0.1:${controlPort}`;
      setBridgeAuthForPort(controlPort, auth);
    }, 30_000);

    afterAll(async () => {
      if (controlServer) {
        deleteBridgeAuthForPort(controlPort);
        await new Promise<void>((resolve, reject) => {
          controlServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (cdpUrl) {
        await closePlaywrightBrowserConnection({ cdpUrl });
      }
      await context?.close();
      if (fixture) {
        await new Promise<void>((resolve, reject) => {
          fixture.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });

    function fixtureUrl(host: string, pathname: string) {
      return `http://${host}:${fixturePort}${pathname}`;
    }

    async function expectPage(targetId: string, url: string, content: string) {
      const snapshot = await browserSnapshot(baseUrl, { targetId, format: "ai" });
      expect(snapshot.url).toBe(url);
      if (snapshot.format !== "ai") {
        throw new Error("Expected AI snapshot");
      }
      expect(snapshot.snapshot).toContain(content);
      await expect.poll(() => context.pages().some((page) => page.url() === url)).toBe(true);
      const page = expectDefined(
        context.pages().find((candidate) => candidate.url() === url),
        "native Chromium page at the reported URL",
      );
      expect(await page.locator("main").textContent()).toBe(content);
      expect((await browserTabs(baseUrl)).tabs).toEqual(
        expect.arrayContaining([expect.objectContaining({ targetId, url })]),
      );
    }

    for (const [name, host] of [
      ["localhost", "localhost"],
      ["RFC1918", privateHost],
    ] as const) {
      it.runIf(Boolean(host)).for(["open", "navigate"] as const)(
        `%s reaches a ${name} page with strict CDP defaults`,
        { timeout: 20_000 },
        async (operation, testContext) => {
          if (name === "RFC1918" && !privateFixtureReachable) {
            testContext.skip("The assigned RFC1918 address cannot reach the fixture on this host");
          }
          const url = fixtureUrl(
            expectDefined(host, "reachable private fixture host"),
            `/${name}-${operation}`,
          );
          const initial = await browserOpenTab(baseUrl, operation === "open" ? url : "about:blank");
          const result =
            operation === "open"
              ? initial
              : await browserNavigate(baseUrl, { targetId: initial.targetId, url });
          expect(result.url).toBe(url);
          await expectPage(result.targetId, url, `Private page /${name}-${operation}`);
        },
      );
    }

    it.runIf(process.env.OPENCLAW_BROWSER_PUBLIC_E2E === "1")(
      "opens and navigates a public page through the authenticated browser client",
      async () => {
        const initial = await browserOpenTab(baseUrl, "https://example.com/");
        expect(initial.url).toBe("https://example.com/");
        const page = expectDefined(
          context.pages().find((candidate) => candidate.url() === initial.url),
          "native Chromium public page",
        );
        expect(await page.title()).toBe("Example Domain");
        expect(await page.locator("body").textContent()).toContain(
          "This domain is for use in documentation examples",
        );
        const url = "https://example.com/?openclaw-navigation-proof";
        const result = await browserNavigate(baseUrl, { targetId: initial.targetId, url });
        expect(result.url).toBe(url);
        expect(page.url()).toBe(url);
        expect(await page.title()).toBe("Example Domain");
      },
      30_000,
    );

    it("reports the committed private URL after a redirect", async () => {
      const result = await browserOpenTab(baseUrl, fixtureUrl("127.0.0.1", "/redirect"));
      const url = fixtureUrl("127.0.0.1", "/redirect-destination");
      expect(result.url).toBe(url);
      await expectPage(result.targetId, url, "Private page /redirect-destination");
    }, 20_000);

    it.each(["click", "batch"] as const)(
      "follows a private link through the %s action path",
      async (kind) => {
        const initial = await browserOpenTab(
          baseUrl,
          fixtureUrl("127.0.0.1", `/links${kind === "batch" ? "?batch" : ""}`),
        );
        const snapshot = await browserSnapshot(baseUrl, {
          targetId: initial.targetId,
          format: "ai",
          interactive: true,
        });
        if (snapshot.format !== "ai") {
          throw new Error("Expected AI snapshot");
        }
        const ref = expectDefined(
          Object.entries(snapshot.refs ?? {}).find(
            ([, info]) => info.name === "Visit destination",
          )?.[0],
          "private navigation link ref",
        );
        const destination = kind === "batch" ? "/batch-destination" : "/click-destination";
        const result = await browserAct(
          baseUrl,
          kind === "click"
            ? { kind, targetId: initial.targetId, ref }
            : {
                kind,
                targetId: initial.targetId,
                actions: [
                  { kind: "click", ref },
                  { kind: "wait", text: `Private page ${destination}` },
                ],
              },
        );
        expect(result.url).toBe(fixtureUrl("127.0.0.1", destination));
        if (kind === "batch") {
          expect(result.results).toEqual([expect.objectContaining({ ok: true, navigated: true })]);
          expect(result.aborted).toMatchObject({
            reason: "navigation",
            afterAction: 1,
            skipped: 1,
          });
        }
        await expectPage(
          result.targetId,
          fixtureUrl("127.0.0.1", destination),
          `Private page ${destination}`,
        );
      },
      20_000,
    );

    it("rejects invalid schemes and embedded credentials before dispatch", async () => {
      const initial = await browserOpenTab(baseUrl, "about:blank");
      const fixtureRequests = requests.length;
      const pages = (await browserTabs(baseUrl)).tabs.length;
      for (const url of [
        "not-a-url",
        "file:///etc/passwd",
        "javascript:alert(1)",
        `http://browser-user:browser-password@127.0.0.1:${fixturePort}/credentials`,
      ]) {
        for (const operation of [
          () => browserOpenTab(baseUrl, url),
          () => browserNavigate(baseUrl, { targetId: initial.targetId, url }),
        ]) {
          const error = await operation().catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(BrowserServiceError);
          expect(error).toMatchObject({ status: 400, reason: "navigation_blocked" });
          expect((error as Error).message).not.toContain("browser-password");
        }
      }
      expect(requests).toHaveLength(fixtureRequests);
      const tabs = (await browserTabs(baseUrl)).tabs;
      expect(tabs).toHaveLength(pages);
      expect(tabs.find((tab) => tab.targetId === initial.targetId)?.url).toBe("about:blank");
    }, 20_000);

    it("keeps HTTP service and browser control authorization enforced", async () => {
      const url = fixtureUrl("127.0.0.1", "/protected");
      expect((await fetch(url)).status).toBe(401);
      const authorized = await fetch(url, { headers: { Authorization: `Bearer ${serviceToken}` } });
      expect(authorized.status).toBe(200);
      expect(await authorized.text()).toContain("Authorized private data");
      const initial = await browserOpenTab(baseUrl, "about:blank");
      const result = await browserNavigate(baseUrl, { targetId: initial.targetId, url });
      await expectPage(result.targetId, url, "Authentication required");
      expect((await fetch(`${baseUrl}/tabs`)).status).toBe(401);
    }, 20_000);
  },
);
