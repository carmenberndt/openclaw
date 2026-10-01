// Explicit navigation URL validation, downloads and exact target recovery.
import { describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import * as pwSessionConnection from "./pw-session-connection.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreDownloadCapture,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.snapshot.js");

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "tab-1" };

function prepareReconnect() {
  const owner: { targetId?: string } = { targetId: "original-target" };
  const originalPage = {
    goto: vi.fn(async () => {
      owner.targetId = undefined;
      throw new Error("page.goto: Frame has been detached");
    }),
    url: vi.fn(() => "https://example.com/original"),
    on: vi.fn(),
    off: vi.fn(),
  };
  const replacementPage = {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.com/recovered"),
    on: vi.fn(),
    off: vi.fn(),
  };
  setPwToolsCoreCurrentPage(originalPage);
  const reconnect = vi.spyOn(pwSessionConnection, "connectBrowser").mockImplementation(async () => {
    owner.targetId = "replacement-target";
    return {} as Awaited<ReturnType<typeof pwSessionConnection.connectBrowser>>;
  });
  return { owner, originalPage, replacementPage, reconnect };
}

describe("Playwright explicit navigation", () => {
  it("blocks unsupported non-network URLs before page lookup", async () => {
    const goto = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "about:blank"),
    });

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "file:///etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(getPwToolsCoreSessionMocks().getPageForTargetId).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it("awaits caller authority and rejects revocation before native navigation", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const goto = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({ goto });
    const operation = mod.navigateViaPlaywright({
      ...target,
      url: "http://localhost:3000/",
      assertCurrent: async () => {
        entered.resolve();
        await release.promise;
        throw new Error("caller authority expired");
      },
    });
    await entered.promise;
    expect(goto).not.toHaveBeenCalled();
    release.resolve();
    await expect(operation).rejects.toThrow("caller authority expired");
    expect(goto).not.toHaveBeenCalled();
  });

  it("dispatches native navigation in the same turn as a synchronous authority assertion", async () => {
    let expired = false;
    const goto = vi.fn(async () => {
      expect(expired).toBe(false);
    });
    setPwToolsCoreCurrentPage({ goto });
    await mod.navigateViaPlaywright({
      ...target,
      url: "http://localhost:3000/",
      assertCurrent: () => {
        queueMicrotask(() => {
          expired = true;
        });
      },
    });
    expect(goto).toHaveBeenCalledOnce();
    expect(expired).toBe(true);
  });

  it("returns managed download metadata when navigation starts an attachment download", async () => {
    const download = {
      url: "https://example.com/export.csv",
      suggestedFilename: "export.csv",
      path: "/tmp/openclaw/downloads/export.csv",
    };
    const downloadCapture = {
      armed: true,
      promise: Promise.resolve(download),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    const page = {
      goto: vi.fn(async () => {
        throw new Error("page.goto: Download is starting");
      }),
      url: vi.fn(() => "https://example.com/start"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await mod.navigateViaPlaywright({
      ...target,
      url: "https://example.com/export.csv",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result).toEqual({ url: download.url, download });
    expect(downloadCapture.cancel).not.toHaveBeenCalled();
  });

  it("handles capture timeouts that win before ordinary navigation settles", async () => {
    let rejectCapture!: (err: Error) => void;
    const downloadCapture = {
      armed: true,
      promise: new Promise<never>((_, reject) => {
        rejectCapture = reject;
      }),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage({
      goto: vi.fn(async () => {
        rejectCapture(new Error("Timeout waiting for navigation download"));
        await Promise.resolve();
      }),
      url: vi.fn(() => "https://example.com/final"),
    });

    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com/final",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result).toEqual({ url: "https://example.com/final" });
    expect(downloadCapture.cancel).toHaveBeenCalledTimes(1);
  });

  it("surfaces managed download save failures", async () => {
    const downloadCapture = {
      armed: true,
      promise: Promise.reject(new Error("download save failed")),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage({
      goto: vi.fn(async () => {
        throw new Error("page.goto: Download is starting");
      }),
      url: vi.fn(() => "https://example.com/start"),
    });

    await expect(
      mod.navigateViaPlaywright({
        ...target,
        url: "https://example.com/export.csv",
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toThrow("download save failed");
  });

  it("rethrows download-starting navigation errors when no download is captured", async () => {
    const downloadCapture = {
      armed: false,
      promise: new Promise<never>(() => {}),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage({
      goto: vi.fn(async () => {
        throw new Error("page.goto: Download is starting");
      }),
      url: vi.fn(() => "https://example.com/start"),
    });

    await expect(
      mod.navigateViaPlaywright({
        ...target,
        url: "https://example.com/export.csv",
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toThrow("Download is starting");

    expect(downloadCapture.cancel).toHaveBeenCalledTimes(1);
  });

  it("reconnects and retries once when navigation detaches frame", async () => {
    const goto = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("page.goto: Frame has been detached"))
      .mockResolvedValueOnce(undefined);
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://example.com/recovered"),
    });

    const result = await mod.navigateViaPlaywright({
      ...target,
      url: "https://example.com/recovered",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(getPwToolsCoreSessionMocks().getPageForTargetId).toHaveBeenCalledTimes(2);
    expect(getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget).toHaveBeenCalledTimes(
      1,
    );
    expect(getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      ...target,
      ssrfPolicy: { allowPrivateNetwork: true },
      page: expect.objectContaining({ goto }),
    });
    expect(goto).toHaveBeenCalledTimes(2);
    expect(result.url).toBe("https://example.com/recovered");
  });

  it("rebinds a detached navigation to the same relay-owned tab after reconnect", async () => {
    const { owner, originalPage, replacementPage, reconnect } = prepareReconnect();
    const session = getPwToolsCoreSessionMocks();
    session.getPageForTargetId
      .mockResolvedValueOnce(originalPage)
      .mockImplementationOnce(async () => {
        const selected = (
          session.getPageForTargetId.mock.calls.at(-1) as unknown[] | undefined
        )?.[0] as { targetId?: string } | undefined;
        if (selected?.targetId !== "replacement-target") {
          throw new BrowserTabNotFoundError({ input: selected?.targetId });
        }
        return replacementPage;
      });

    try {
      const navigation = {
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "original-target",
        url: "https://example.com/recovered",
        resolveOperationTarget: () => owner.targetId,
      };
      const result = await mod.navigateViaPlaywright(navigation);

      expect(reconnect).toHaveBeenCalledWith("http://127.0.0.1:18792", undefined, undefined);
      expect(session.getPageForTargetId).toHaveBeenLastCalledWith(
        expect.objectContaining({ targetId: "replacement-target" }),
      );
      expect(replacementPage.goto).toHaveBeenCalledTimes(1);
      expect(result.url).toBe("https://example.com/recovered");
    } finally {
      reconnect.mockRestore();
    }
  });

  it.each([
    { reason: "owner is revoked before selection", revokeDuringLookup: false },
    { reason: "owner changes during the exact page lookup", revokeDuringLookup: true },
  ])("rejects detached navigation when its $reason", async ({ revokeDuringLookup }) => {
    const { owner, originalPage, replacementPage, reconnect } = prepareReconnect();
    reconnect.mockImplementation(async () => {
      owner.targetId = revokeDuringLookup ? "replacement-target" : undefined;
      return {} as Awaited<ReturnType<typeof pwSessionConnection.connectBrowser>>;
    });
    const session = getPwToolsCoreSessionMocks();
    session.getPageForTargetId.mockResolvedValueOnce(originalPage);
    if (revokeDuringLookup) {
      session.getPageForTargetId.mockImplementationOnce(async () => {
        owner.targetId = "unrelated-target";
        return replacementPage;
      });
    }

    try {
      await expect(
        mod.navigateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "original-target",
          url: "https://example.com/recovered",
          resolveOperationTarget: () => owner.targetId,
        }),
      ).rejects.toBeInstanceOf(BrowserTabNotFoundError);

      expect(replacementPage.goto).not.toHaveBeenCalled();
      expect(session.getPageForTargetId).toHaveBeenCalledTimes(revokeDuringLookup ? 2 : 1);
    } finally {
      reconnect.mockRestore();
    }
  });
});
