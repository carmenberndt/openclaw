import { describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";
installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.interactions.actions.js");
const { executeActViaPlaywright } = await import("./pw-tools-core.interactions.execution.js");
const { waitForViaPlaywright } = await import("./pw-tools-core.interactions.content.js");
const { resizeViewportViaPlaywright } = await import("./pw-tools-core.snapshot.js");
const session = getPwToolsCoreSessionMocks();
const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
const localPageUrl = "http://127.0.0.1:9222/json/version";
const hoverAction = { kind: "hover", ref: "1" } as const;
const downloadGrace = { firstEventGraceMs: 250, maxWaitMs: 1_000, quietMs: 250 };
function install(page: Record<string, unknown>, locator?: Record<string, unknown>) {
  setPwToolsCoreCurrentPage(page);
  if (locator) {
    setPwToolsCoreCurrentRefLocator(locator);
  }
}
function captureDownloads(
  drain: ReturnType<typeof session.beginActionDownloadCaptureOnPage>["drain"],
) {
  const dispose = vi.fn();
  session.beginActionDownloadCaptureOnPage.mockReturnValueOnce({ drain, dispose });
  return dispose;
}
describe("interaction results and download lifecycle", () => {
  it("runs statement-body page evaluate sources", async () => {
    const page = {
      evaluate: vi.fn(async (fn: (args: unknown) => unknown, args: unknown) => fn(args)),
      url: vi.fn(() => localPageUrl),
    };
    install(page);
    expect(
      await mod.evaluateViaPlaywright({ ...target, fn: "const value = 41; return value + 1;" }),
    ).toBe(42);
    expect(page.evaluate.mock.calls[0]?.[1]).toMatchObject({
      fnSource: "async () => {\nconst value = 41; return value + 1;\n}",
    });
  });

  it("runs statement-body ref evaluate sources", async () => {
    const locator = {
      evaluate: vi.fn(async (fn: (el: Element, args: unknown) => unknown, args: unknown) =>
        fn({ textContent: "Ada" } as Element, args),
      ),
    };
    install({ url: vi.fn(() => localPageUrl) }, locator);
    expect(
      await mod.evaluateViaPlaywright({
        ...target,
        ref: "1",
        fn: "const text = el.textContent; return text;",
      }),
    ).toBe("Ada");
    expect(locator.evaluate.mock.calls[0]?.[1]).toMatchObject({
      fnSource: "async (el) => {\nconst text = el.textContent; return text;\n}",
    });
  });

  it("returns click downloads after the native event grace", async () => {
    const page = { url: vi.fn(() => "https://example.com") };
    const download = {
      url: "https://example.com/report.pdf",
      suggestedFilename: "report.pdf",
      path: "/tmp/openclaw/downloads/report.pdf",
    };
    const drain = vi.fn(async () => [download]);
    const dispose = captureDownloads(drain);
    install(page, { click: vi.fn(async () => {}) });
    const result = await executeActViaPlaywright({
      ...target,
      action: { kind: "click", ref: "1" },
    });
    expect(result.downloads).toEqual([
      {
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ]);
    expect(drain).toHaveBeenCalledWith(downloadGrace);
    expect(dispose).toHaveBeenCalledOnce();
    expect(session.beginActionDownloadCaptureOnPage).toHaveBeenCalledWith(page);
  });

  it("retains download grace when a native hover aborts", async () => {
    const ctrl = new AbortController();
    const started = Promise.withResolvers<void>();
    const hover = Promise.withResolvers<void>();
    const drain = vi.fn(async () => undefined);
    const dispose = captureDownloads(drain);
    install(
      { url: vi.fn(() => "https://example.com") },
      {
        hover: vi.fn(() => {
          started.resolve();
          return hover.promise;
        }),
      },
    );
    const task = executeActViaPlaywright({
      ...target,
      action: hoverAction,
      signal: ctrl.signal,
    });
    await started.promise;
    ctrl.abort(new Error("aborted by test"));
    expect(drain).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    hover.resolve();
    await expect(task).rejects.toThrow("aborted by test");
    expect(drain).toHaveBeenCalledWith(downloadGrace);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("retains the download grace when an executable wait aborts", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("aborted by test"));
    const page = {
      url: vi.fn(() => "https://example.com"),
      waitForFunction: vi.fn(async () => {}),
    };
    const drain = vi.fn(async () => undefined);
    const dispose = captureDownloads(drain);
    install(page);
    await expect(
      executeActViaPlaywright({
        ...target,
        action: { kind: "wait", fn: "() => false" },
        evaluateEnabled: true,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("aborted by test");
    expect(drain).toHaveBeenCalledWith(downloadGrace);
    expect(dispose).toHaveBeenCalledOnce();
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });
});

describe("resident interaction authority", () => {
  it.each(["type", "wait", "resize"] as const)(
    "starts each %s effect in the same turn as its final assertion",
    async (kind) => {
      const events: string[] = [];
      const effect = vi.fn(async () => {
        expect(events.at(-1)).toBe("assert");
        events.push("effect");
      });
      setPwToolsCoreCurrentRefLocator({ click: effect, fill: effect, press: effect });
      setPwToolsCoreCurrentPage({
        setViewportSize: effect,
        evaluateHandle: async () => {
          await effect();
          return { dispose: async () => {} };
        },
        waitForFunction: effect,
      });
      const opts = {
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        assertCurrent: () => {
          events.push("assert");
          queueMicrotask(() => events.push("yield"));
        },
      };
      switch (kind) {
        case "type":
          await mod.typeViaPlaywright({ ...opts, ref: "1", text: "review", submit: true });
          break;
        case "wait":
          await waitForViaPlaywright({ ...opts, fn: "() => true" });
          break;
        case "resize":
          await resizeViewportViaPlaywright({ ...opts, width: 800, height: 600 });
          break;
      }
      expect(effect).toHaveBeenCalledTimes(kind === "resize" ? 1 : 2);
    },
  );

  it("still awaits an asynchronous authority and preserves its rejection", async () => {
    const entered = Promise.withResolvers<void>();
    const admission = Promise.withResolvers<void>();
    const click = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({});
    setPwToolsCoreCurrentRefLocator({ click });
    const pending = mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      assertCurrent: () => {
        entered.resolve();
        return admission.promise;
      },
    });
    const rejected = expect(pending).rejects.toThrow("actor revoked");
    await entered.promise;
    expect(click).not.toHaveBeenCalled();
    admission.reject(new Error("actor revoked"));
    await rejected;
    expect(click).not.toHaveBeenCalled();
  });

  it("rechecks resize authority after clearing the previous metrics owner", async () => {
    let current = true;
    const send = vi.fn(async () => {
      current = false;
    });
    const setViewportSize = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({ setViewportSize });
    Object.assign(getPwToolsCoreSessionMocks().ensurePageState(), {
      emulation: {
        metricsOwner: { viewport: { width: 400, height: 300 }, session: { send } },
      },
    });
    await expect(
      resizeViewportViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        width: 800,
        height: 600,
        assertCurrent: () => {
          if (!current) {
            throw new Error("actor revoked");
          }
        },
      }),
    ).rejects.toThrow("actor revoked");
    expect(send).toHaveBeenCalledWith("Emulation.clearDeviceMetricsOverride");
    expect(setViewportSize).not.toHaveBeenCalled();
  });
});
