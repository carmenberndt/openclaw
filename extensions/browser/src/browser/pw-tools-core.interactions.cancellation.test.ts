import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserObservedDialogBlockedError } from "./pw-session-contracts.js";

const pageState = vi.hoisted(() => ({
  page: null as Record<string, unknown> | null,
  locator: null as Record<string, unknown> | null,
}));

const session = vi.hoisted(() => ({
  ensurePageState: vi.fn(() => ({})),
  forceDisconnectPlaywrightForTarget: vi.fn(async () => {}),
  getPageForTargetId: vi.fn(async () => {
    if (!pageState.page) {
      throw new Error("missing page");
    }
    return pageState.page;
  }),
  isBrowserObservedDialogBlockedError: vi.fn((_err: unknown) => false),
  markObservedDialogsHandledRemotelyForPage: vi.fn(() => ({})),
  refLocator: vi.fn(() => {
    if (!pageState.locator) {
      throw new Error("missing locator");
    }
    return pageState.locator;
  }),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  storeRoleRefsForTarget: vi.fn(() => {}),
}));

vi.mock("./pw-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-session.js")>()),
  ...session,
}));

const pw = await import("./pw-tools-core.interactions.actions.js");
const { waitForViaPlaywright } = await import("./pw-tools-core.interactions.content.js");

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "tab-1" };

function trackSettlement(task: Promise<unknown>) {
  const settled = vi.fn();
  void task.finally(settled).catch(() => {});
  return settled;
}

function install(page: Record<string, unknown>, locator: Record<string, unknown> = {}): void {
  pageState.page = page;
  pageState.locator = locator;
}

function documentPage<T>(waitForFunction: T, url = "https://example.com") {
  const documentHandle = { dispose: vi.fn(async () => {}) };
  const page = {
    url: vi.fn(() => url),
    evaluateHandle: vi.fn(async () => documentHandle),
    waitForFunction,
  };
  install(page);
  return { page, documentHandle };
}

describe("Playwright interaction cancellation", () => {
  beforeEach(() => {
    pageState.page = null;
    pageState.locator = null;
    session.isBrowserObservedDialogBlockedError.mockReturnValue(false);
    for (const fn of Object.values(session)) {
      fn.mockClear();
    }
  });

  it.each(["() => true", "async () => true"])(
    "binds %s wait predicates to their original document",
    async (fn) => {
      let currentUrl = "https://example.com";
      const order: string[] = [];
      const documentHandle = { dispose: vi.fn(async () => {}) };
      const waitForFunction = vi.fn(
        async (
          predicate: (state: { document: unknown }) => boolean,
          state: { document: unknown },
        ) => {
          order.push("predicate");
          const browserState = { ...state, document: globalThis.document };
          expect(predicate(browserState)).toBe(!fn.startsWith("async"));
          if (fn.startsWith("async")) {
            await Promise.resolve();
            expect(predicate(browserState)).toBe(true);
          }
          currentUrl = "https://93.184.216.34/target";
        },
      );
      install({
        url: () => currentUrl,
        evaluateHandle: vi.fn(async () => documentHandle),
        waitForTimeout: vi.fn(async () => {
          order.push("passive");
        }),
        waitForFunction,
      });
      await waitForViaPlaywright({ ...target, timeMs: 1, fn });
      expect(waitForFunction).toHaveBeenCalledOnce();
      expect(waitForFunction).toHaveBeenCalledWith(
        expect.any(Function),
        { document: documentHandle },
        { timeout: expect.any(Number) },
      );
      expect(order).toEqual(["passive", "predicate"]);
      expect(documentHandle.dispose).toHaveBeenCalledOnce();
    },
  );

  it("does not recreate a wait predicate in a replacement document", async () => {
    const { documentHandle } = documentPage(
      vi.fn(
        async (
          predicate: (state: { document: unknown }) => boolean,
          state: { document: unknown },
        ) => predicate({ ...state, document: {} }),
      ),
      "https://example.com/next",
    );

    await expect(
      waitForViaPlaywright({
        ...target,
        fn: "() => document.cookie",
      }),
    ).rejects.toThrow("Wait predicate document changed");

    expect(documentHandle.dispose).toHaveBeenCalledOnce();
  });

  it("does not start a predicate after aborting an earlier wait condition", async () => {
    const ctrl = new AbortController();
    const dialogError = new BrowserObservedDialogBlockedError({
      dialogs: { pending: [], recent: [] },
    });
    session.isBrowserObservedDialogBlockedError.mockReturnValueOnce(true);
    const waitForFunction = vi.fn(async () => {});
    pageState.page = {
      url: vi.fn(() => "https://example.com"),
      waitForTimeout: vi.fn(async () => {
        ctrl.abort(dialogError);
      }),
      waitForFunction,
    };

    await expect(
      waitForViaPlaywright({
        ...target,
        timeMs: 1,
        fn: "() => true",
        signal: ctrl.signal,
      }),
    ).rejects.toBe(dialogError);
    await Promise.resolve();
    expect(waitForFunction).not.toHaveBeenCalled();
    expect(session.markObservedDialogsHandledRemotelyForPage).toHaveBeenCalledWith(
      pageState.page,
      dialogError.browserState.dialogs.pending,
    );
  });

  it("does not start a predicate when document capture finishes after abort", async () => {
    const ctrl = new AbortController();
    const waitForFunction = vi.fn(async () => {});
    const { page, documentHandle } = documentPage(waitForFunction);
    page.evaluateHandle.mockImplementation(async () => {
      ctrl.abort(new Error("aborted during document capture"));
      return documentHandle;
    });

    await expect(
      waitForViaPlaywright({
        ...target,
        fn: "() => true",
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("aborted during document capture");

    expect(waitForFunction).not.toHaveBeenCalled();
    expect(documentHandle.dispose).toHaveBeenCalledOnce();
  });

  it("joins a cancelled native click without disconnecting its browser", async () => {
    const ctrl = new AbortController();
    const clickStarted = Promise.withResolvers<void>();
    const click = Promise.withResolvers<void>();
    let nativeSignal: AbortSignal | undefined;
    install(
      { url: vi.fn(() => "https://example.com") },
      {
        click: vi.fn((options: { signal?: AbortSignal }) => {
          nativeSignal = options.signal;
          clickStarted.resolve();
          return click.promise;
        }),
      },
    );

    const task = pw.clickViaPlaywright({
      ...target,
      ref: "1",
      signal: ctrl.signal,
    });

    await clickStarted.promise;
    ctrl.abort(new Error("aborted by test"));
    expect(nativeSignal?.aborted).toBe(true);
    click.reject(
      Object.assign(new Error("cancelled", { cause: nativeSignal?.reason }), {
        name: "AbortError",
      }),
    );

    await expect(task).rejects.toThrow("aborted by test");
    expect(session.forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
  });

  it.each([
    { label: "fill before submit", slowly: false, firstMethod: "fill" as const },
    { label: "click before slow type", slowly: true, firstMethod: "click" as const },
  ])("stops a multi-step type action after aborting $label", async ({ slowly, firstMethod }) => {
    const ctrl = new AbortController();
    const started = Promise.withResolvers<void>();
    const firstStepPending = Promise.withResolvers<void>();
    const click = vi.fn(async () => {});
    const fill = vi.fn(async () => {});
    const type = vi.fn(async () => {});
    const press = vi.fn(async () => {});
    const firstStep = vi.fn(() => {
      started.resolve();
      return firstStepPending.promise;
    });
    if (firstMethod === "click") {
      click.mockImplementation(firstStep);
    } else {
      fill.mockImplementation(firstStep);
    }
    install({ url: () => "https://example.com" }, { click, fill, type, press });

    const task = pw.typeViaPlaywright({
      ...target,
      ref: "1",
      text: "value",
      submit: true,
      slowly,
      signal: ctrl.signal,
    });

    const settled = trackSettlement(task);
    await started.promise;
    ctrl.abort(new Error("aborted by test"));
    expect(settled).not.toHaveBeenCalled();
    firstStepPending.resolve();
    await expect(task).rejects.toThrow("aborted by test");
    expect(settled).toHaveBeenCalledOnce();
    expect(type).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
  });

  it("disconnects a pending page evaluation on caller cancellation", async () => {
    const ctrl = new AbortController();
    const entered = Promise.withResolvers<void>();
    pageState.page = {
      url: () => "https://example.com/current",
      evaluate: () => {
        entered.resolve();
        return new Promise(() => {});
      },
    };
    const task = pw.evaluateViaPlaywright({
      ...target,
      fn: "() => 1",
      signal: ctrl.signal,
    });
    await entered.promise;
    ctrl.abort(new Error("aborted by test"));
    await expect(task).rejects.toThrow("aborted by test");
    expect(session.forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      ...target,
      page: pageState.page,
    });
  });

  it("reconciles an observed dialog after evaluation settles without disconnecting", async () => {
    const ctrl = new AbortController();
    const entered = Promise.withResolvers<void>();
    const evaluation = Promise.withResolvers<boolean>();
    pageState.page = {
      url: () => "https://example.com/current",
      evaluate: () => {
        entered.resolve();
        return evaluation.promise;
      },
    };
    const task = pw.evaluateViaPlaywright({
      ...target,
      fn: "() => alert('x')",
      signal: ctrl.signal,
    });
    await entered.promise;
    const error = new BrowserObservedDialogBlockedError({
      dialogs: {
        pending: [{ id: "d1", type: "alert", message: "x", openedAt: "2026-09-08T00:00:00Z" }],
        recent: [],
      },
    });
    session.isBrowserObservedDialogBlockedError.mockImplementation(
      (err) => err instanceof BrowserObservedDialogBlockedError,
    );
    ctrl.abort(error);
    await expect(task).rejects.toBe(error);
    expect(session.forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
    evaluation.resolve(true);
    await vi.waitFor(() =>
      expect(session.markObservedDialogsHandledRemotelyForPage).toHaveBeenCalledWith(
        pageState.page,
        error.browserState.dialogs.pending,
      ),
    );
  });

  it("unwinds the hold-delay action chain promptly when aborted mid-delay", async () => {
    vi.useFakeTimers();
    try {
      const hover = vi.fn(async () => {});
      const click = vi.fn(async () => {});
      install({ url: vi.fn(() => "https://example.test/hold") }, { hover, click });

      const ctrl = new AbortController();
      const task = pw.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        delayMs: 5_000,
        signal: ctrl.signal,
      });
      const settled = task.then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );

      // Enter the click-and-hold delay, then abort 100ms into the 5s hold.
      await vi.advanceTimersByTimeAsync(100);
      expect(hover).toHaveBeenCalledTimes(1);
      ctrl.abort(new Error("aborted by test"));

      // Join cancellation without waiting out the hold.
      await vi.advanceTimersByTimeAsync(1_000);
      const outcome = await settled;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(Error);
        if (outcome.reason instanceof Error) {
          expect(outcome.reason.message).toContain("aborted by test");
        }
      }
      expect(click).not.toHaveBeenCalled();
      expect(session.forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still waits the full hold delay before clicking when not aborted", async () => {
    vi.useFakeTimers();
    try {
      const hover = vi.fn(async () => {});
      const click = vi.fn(async () => {});
      install({ url: vi.fn(() => "https://example.test/hold") }, { hover, click });

      const task = pw.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        delayMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(hover).toHaveBeenCalledTimes(1);
      expect(click).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await task;
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
