import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";
import { downloadCurrentDocumentViaPlaywright } from "./pw-tools-core.downloads.js";

const sourceHostname = "download-source.test";

describe.runIf(process.env.OPENCLAW_BROWSER_DOWNLOAD_E2E === "1")(
  "current document redirect download (real Chromium)",
  () => {
    let context: BrowserContext;
    let page: Page;
    let rootDir: string;
    let cdpUrl: string;
    let targetId: string;
    let sourceUrl: string;
    let destinationUrl: string;
    let bytes: Buffer;
    let redirect = false;
    let sourceRequests = 0;
    let destinationRequests = 0;
    let destinationConnections = 0;
    const source = createServer((req, res) => {
      if (req.url !== "/asset.png") {
        res.writeHead(404).end();
        return;
      }
      sourceRequests += 1;
      if (redirect) {
        res.writeHead(302, { Location: destinationUrl }).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }).end(bytes);
    });
    const destination = createServer((_req, res) => {
      destinationRequests += 1;
      res
        .writeHead(200, {
          "Content-Type": "image/png",
          "Content-Disposition": 'attachment; filename="redirected.png"',
        })
        .end(bytes);
    });
    destination.on("connection", () => {
      destinationConnections += 1;
    });

    beforeAll(async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-redirect-"));
      bytes = await fs.readFile(new URL("../../assets/icon.png", import.meta.url));
      destination.listen(0, "127.0.0.1");
      await once(destination, "listening");
      source.listen(0, "127.0.0.1");
      await once(source, "listening");
      const sourceAddress = source.address();
      const destinationAddress = destination.address();
      if (
        !sourceAddress ||
        typeof sourceAddress === "string" ||
        !destinationAddress ||
        typeof destinationAddress === "string"
      ) {
        throw new Error("Fixture servers did not bind");
      }
      sourceUrl = `http://${sourceHostname}:${sourceAddress.port}/asset.png`;
      destinationUrl = `http://127.0.0.1:${destinationAddress.port}/redirected.png`;
      const profileDir = path.join(rootDir, "chromium-profile");
      context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        acceptDownloads: true,
        args: [
          "--remote-debugging-port=0",
          "--no-proxy-server",
          `--host-resolver-rules=MAP ${sourceHostname} 127.0.0.1`,
        ],
      });
      const port = (await fs.readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).split(
        "\n",
      )[0];
      cdpUrl = `http://127.0.0.1:${port}`;
      page = await context.newPage();
      const session = await context.newCDPSession(page);
      ({
        targetInfo: { targetId },
      } = await session.send("Target.getTargetInfo"));
      await session.detach();
      // Exercise an already-active CDP session, not an unrelated connection-policy refusal.
      await getPageForTargetId({
        cdpUrl,
        targetId,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      });
    }, 30_000);

    afterAll(async () => {
      await closePlaywrightBrowserConnection({ cdpUrl });
      await context?.close();
      for (const server of [source, destination]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
      await fs.rm(rootDir, { recursive: true, force: true });
    });

    async function displaySource() {
      redirect = false;
      await page.goto(sourceUrl);
      expect(page.url()).toBe(sourceUrl);
      redirect = true;
    }

    function save() {
      return downloadCurrentDocumentViaPlaywright({
        cdpUrl,
        targetId,
        expectedUrl: sourceUrl,
        rootDir: path.join(rootDir, "downloads"),
        timeoutMs: 10_000,
      });
    }

    it("follows a native redirect to loopback and saves exact bytes while preserving the preview", async () => {
      await displaySource();
      const initialSourceRequests = sourceRequests;
      const result = await save();
      expect(sourceRequests).toBe(initialSourceRequests + 1);
      expect(destinationRequests).toBeGreaterThan(0);
      expect(destinationConnections).toBeGreaterThan(0);
      expect(await fs.readFile(result.path)).toEqual(bytes);
      expect(page.url()).toBe(sourceUrl);
      console.info(
        JSON.stringify({
          bytes: bytes.length,
          destinationRequests,
          destinationConnections,
        }),
      );
    }, 15_000);
  },
);
