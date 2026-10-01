// Existing-session execution deadlines, cancellation and document-bound waits.
import { setTimeout as sleep } from "node:timers/promises";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMcpOperationOptions } from "../chrome-mcp.js";
import { browserAct } from "../client-actions.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import type { BrowserDispatchRequest, BrowserDispatchResponse } from "./dispatcher.js";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    // Drive both route sleeps and synthetic MCP work with the test's global clock.
    setTimeout: <T = void>(
      delay?: number,
      value?: T,
      options?: Parameters<typeof actual.setTimeout>[2],
    ) =>
      new Promise<T | undefined>((resolve, reject) => {
        const signal = options?.signal;
        signal?.throwIfAborted();
        const abort = () => {
          clearTimeout(timer);
          reject(toErrorObject(signal?.reason, "Browser action cancelled"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        }, delay);
        signal?.addEventListener("abort", abort, { once: true });
      }),
  };
});

const chromeMcpMocks = vi.hoisted(() => ({
  ChromeMcpDocumentUnavailableError: class ChromeMcpDocumentUnavailableError extends Error {},
  clickChromeMcpCoords: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  clickChromeMcpElement: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(
    async (_params: ChromeMcpOperationOptions) => "https://example.com",
  ),
  fillChromeMcpElement: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  selectChromeMcpOption: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  hoverChromeMcpElement: vi.fn(async () => {}),
  pressChromeMcpKey: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  withChromeMcpDocument: vi.fn(
    async (
      _params: ChromeMcpOperationOptions,
      task: (document: { evaluate: (fn: string) => unknown }) => unknown,
    ) =>
      await task({
        evaluate: async (fn) =>
          fn.includes("return boundDocument")
            ? "https://example.com"
            : { kind: "result", ready: true },
      }),
  ),
}));

const transportMocks = vi.hoisted(() => ({
  dispatch: vi.fn<(request: BrowserDispatchRequest) => Promise<BrowserDispatchResponse>>(),
}));

vi.mock("../local-dispatch.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../local-dispatch.runtime.js")>()),
  dispatchBrowserControlRequest: transportMocks.dispatch,
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>();
  const syntheticConfig = {
    browser: {
      defaultProfile: "chrome-live",
      profiles: { "chrome-live": { driver: "existing-session", color: "#123456" } },
    },
  };
  return {
    ...actual,
    getRuntimeConfig: () => syntheticConfig,
    loadConfig: () => syntheticConfig,
  };
});

vi.mock("../chrome-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chrome-mcp.js")>()),
  ...chromeMcpMocks,
  closeChromeMcpTab: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
}));

vi.mock("./agent.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent.shared.js")>()),
  ...createExistingSessionAgentSharedModule(),
}));

const TARGET_REFRESH_ACTIONS = [
  { kind: "hover", ref: "btn-1" },
  { kind: "scrollIntoView", ref: "btn-1" },
  { kind: "drag", startRef: "item-1", endRef: "slot-1" },
  { kind: "fill", fields: [{ ref: "input-1", value: "Ada" }] },
] as const;

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");
const { resolveRouteTabUrl, withRouteTabContext } = await import("./agent.shared.js");
const routeState = existingSessionRouteState;
const defaultResolveRouteTabUrl = vi.mocked(resolveRouteTabUrl).getMockImplementation();
if (!defaultResolveRouteTabUrl) {
  throw new Error("missing existing-session URL resolver mock");
}
const defaultWithRouteTabContext = vi.mocked(withRouteTabContext).getMockImplementation();
if (!defaultWithRouteTabContext) {
  throw new Error("missing existing-session route context mock");
}

function getActPostHandler() {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, {
    state: () => ({
      resolved: {
        actionTimeoutMs: 60_000,
        evaluateEnabled: true,
      },
    }),
  } as never);
  const handler = postHandlers.get("/act");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("existing-session execution deadlines", () => {
  const clientControllers: AbortController[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(chromeMcpMocks)) {
      if ("mockReset" in fn) {
        fn.mockReset();
      }
    }
    chromeMcpMocks.clickChromeMcpCoords.mockResolvedValue(undefined);
    chromeMcpMocks.clickChromeMcpElement.mockResolvedValue(undefined);
    chromeMcpMocks.dragChromeMcpElement.mockResolvedValue(undefined);
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue("https://example.com");
    chromeMcpMocks.fillChromeMcpElement.mockResolvedValue(undefined);
    chromeMcpMocks.fillChromeMcpForm.mockResolvedValue(undefined);
    chromeMcpMocks.hoverChromeMcpElement.mockResolvedValue(undefined);
    chromeMcpMocks.pressChromeMcpKey.mockResolvedValue(undefined);
    transportMocks.dispatch.mockReset();
    vi.mocked(resolveRouteTabUrl).mockReset().mockImplementation(defaultResolveRouteTabUrl);
    vi.mocked(withRouteTabContext).mockReset().mockImplementation(defaultWithRouteTabContext);
    chromeMcpMocks.withChromeMcpDocument.mockImplementation(
      async (
        _params: unknown,
        task: (document: { evaluate: (fn: string) => unknown }) => unknown,
      ) =>
        await task({
          evaluate: async (fn) =>
            fn.includes("return boundDocument")
              ? "https://example.com"
              : { kind: "result", ready: true },
        }),
    );
    routeState.tab.url = "https://example.com";
    routeState.profileCtx.closeTab.mockReset();
    routeState.profileCtx.closeTab.mockResolvedValue(undefined);
    routeState.profileCtx.listTabs.mockReset();
    routeState.profileCtx.listTabs.mockResolvedValue([
      {
        targetId: "7",
        url: "https://example.com",
      },
    ]);
  });

  afterEach(async () => {
    try {
      for (const controller of clientControllers.splice(0)) {
        controller.abort(new Error("test cleanup"));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  async function startClientAction(body: BrowserActRequest) {
    const handler = getActPostHandler();
    if (!handler) {
      throw new Error("missing /act handler");
    }
    transportMocks.dispatch.mockImplementation(async (request) => {
      const response = createBrowserRouteResponse();
      try {
        await handler(
          {
            params: {},
            query: request.query ?? {},
            body: request.body,
            signal: request.signal,
          },
          response.res,
        );
      } catch (error) {
        response.res.status(500).json({ error: String(error) });
      }
      return { status: response.statusCode, body: response.body };
    });
    const controller = new AbortController();
    clientControllers.push(controller);
    const settled = vi.fn();
    const completion = browserAct(undefined, body, {
      profile: "chrome-live",
      signal: controller.signal,
    }).then(
      (result) => {
        settled();
        return { result };
      },
      (error: unknown) => {
        settled();
        return { error };
      },
    );
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    return { completion, settled };
  }

  async function expectClientError(
    request: Awaited<ReturnType<typeof startClientAction>>,
    message: string,
  ) {
    expect(await request.completion).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining(message) }),
    });
  }

  function setWaitReadyAfter(delayMs: number) {
    const readyAt = Date.now() + delayMs;
    chromeMcpMocks.withChromeMcpDocument.mockImplementation(async (_params, task) =>
      task({
        evaluate: async (fn) =>
          fn.includes("return boundDocument")
            ? "https://example.com"
            : { kind: "result", ready: Date.now() >= readyAt },
      }),
    );
  }

  async function runAction(body: Record<string, unknown>) {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    const pending = handler?.({ params: {}, query: {}, body }, response.res);
    await vi.runAllTimersAsync();
    await pending;
    return response;
  }

  async function expectActionToThrow(body: Record<string, unknown>, message: string) {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    const pending = handler?.({ params: {}, query: {}, body }, response.res) ?? Promise.resolve();
    void pending.catch(() => {});
    const completion = (async () => {
      await vi.runAllTimersAsync();
      await pending;
    })();

    await expect(completion).rejects.toThrow(message);
  }

  it("keeps a default existing-session wait alive past the managed wait deadline", async () => {
    setWaitReadyAfter(30_000);
    const request = await startClientAction({ kind: "wait", text: "ready" });

    await vi.advanceTimersByTimeAsync(25_001);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);

    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      result: { ok: true, targetId: "7", url: "https://example.com" },
    });
  });

  it("returns the tab URL after a normalized click", async () => {
    chromeMcpMocks.clickChromeMcpElement.mockImplementationOnce(async ({ signal }) => {
      await sleep(40_000, undefined, { signal });
    });
    chromeMcpMocks.evaluateChromeMcpScript.mockImplementation(async ({ signal }) => {
      await sleep(10_000, undefined, { signal });
      return "https://example.com";
    });
    const request = await startClientAction({
      kind: "click",
      ref: "button",
      button: " left ",
      selector: " ",
    });

    await vi.advanceTimersByTimeAsync(40_000);

    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      result: { ok: true, targetId: "7", url: "https://example.com" },
    });
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("lets an existing-session evaluation use its requested timeout beyond two minutes", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockImplementationOnce(async ({ signal }) => {
      await sleep(150_000, undefined, { signal });
      return "evaluation complete";
    });
    const request = await startClientAction({
      kind: "evaluate",
      fn: "() => window.ready",
      timeoutMs: 180_000,
    });

    await vi.advanceTimersByTimeAsync(125_251);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24_749);

    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      result: { ok: true, result: "evaluation complete" },
    });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 180_000 }),
    );
  });

  it("includes browser and tab preparation in the overall action deadline", async () => {
    const preparationSteps: string[] = [];
    vi.mocked(withRouteTabContext).mockImplementationOnce(async (params) => {
      await sleep(55_000, undefined, { signal: params.req.signal });
      preparationSteps.push("browser ready");
      await sleep(55_000, undefined, { signal: params.req.signal });
      preparationSteps.push("tab verified");
      return await defaultWithRouteTabContext(params);
    });
    let evaluationSignal: AbortSignal | undefined;
    chromeMcpMocks.evaluateChromeMcpScript.mockImplementationOnce(async ({ signal }) => {
      evaluationSignal = signal;
      await sleep(20_000, undefined, { signal });
      return "evaluation complete";
    });
    const request = await startClientAction({ kind: "evaluate", fn: "() => document.title" });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(preparationSteps).toEqual(["browser ready"]);
    expect(evaluationSignal).toBeUndefined();
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(evaluationSignal).toBeUndefined();
    expect(request.settled).toHaveBeenCalledOnce();
    await expectClientError(request, "Browser action request timed out after 60000ms");
    expect(transportMocks.dispatch.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  });

  it("cancels a slow submit at the request deadline after filling succeeds", async () => {
    const completed: string[] = [];
    let submitSignal: AbortSignal | undefined;
    chromeMcpMocks.fillChromeMcpElement.mockImplementationOnce(async ({ signal }) => {
      await sleep(45_000, undefined, { signal });
      completed.push("fill");
    });
    chromeMcpMocks.pressChromeMcpKey.mockImplementationOnce(async ({ signal }) => {
      submitSignal = signal;
      await sleep(45_000, undefined, { signal });
      completed.push("submit");
    });
    const request = await startClientAction({
      kind: "type",
      ref: "field",
      text: "hello",
      submit: true,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(completed).toEqual(["fill"]);
    expect(submitSignal?.aborted).toBe(false);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(submitSignal?.aborted).toBe(true);
    expect(request.settled).toHaveBeenCalledOnce();
    await expectClientError(request, "Browser action request timed out after 60000ms");
    expect(completed).toEqual(["fill"]);
    expect(transportMocks.dispatch.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  });

  it("does not submit when filling completes after the request deadline before its timer runs", async () => {
    chromeMcpMocks.fillChromeMcpElement.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 60_001);
    });
    const request = await startClientAction({
      kind: "type",
      ref: "field",
      text: "hello",
      submit: true,
    });

    expect(chromeMcpMocks.fillChromeMcpElement).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.pressChromeMcpKey).not.toHaveBeenCalled();
    expect(request.settled).toHaveBeenCalledOnce();
    await expectClientError(request, "Browser action request timed out after 60000ms");
  });

  it.each([
    {
      name: "delay exceeding call timeout",
      body: { kind: "wait", timeMs: 1_000, timeoutMs: 500 },
      durationMs: 1_000,
    },
    {
      name: "condition after a delay",
      body: { kind: "wait", timeMs: 1_000, text: "ready", timeoutMs: 500 },
      durationMs: 1_250,
    },
  ] satisfies Array<{
    name: string;
    body: BrowserActRequest;
    durationMs: number;
  }>)(
    "completes a healthy existing-session $name through the client transport",
    async ({ body, durationMs }) => {
      setWaitReadyAfter(durationMs);
      const request = await startClientAction(body);
      await vi.advanceTimersByTimeAsync(durationMs);
      expect(request.settled).toHaveBeenCalledOnce();
      expect(await request.completion).toMatchObject({ result: { ok: true, targetId: "7" } });
    },
  );

  it("preserves the condition timeout while cancelling an outstanding snapshot", async () => {
    let snapshotSignal: AbortSignal | undefined;
    chromeMcpMocks.withChromeMcpDocument.mockImplementationOnce(async (params) => {
      snapshotSignal = params.signal;
      await sleep(1_000, undefined, { signal: params.signal });
      return false;
    });
    const request = await startClientAction({ kind: "wait", selector: "#missing", timeoutMs: 250 });
    await vi.advanceTimersByTimeAsync(249);
    expect(snapshotSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshotSignal?.aborted).toBe(true);
    expect(snapshotSignal?.reason).toEqual(new Error("Timed out waiting for condition"));
    await expectClientError(request, "Timed out waiting for condition");
  });

  it("rejects a condition that finishes after its deadline before the timer runs", async () => {
    chromeMcpMocks.withChromeMcpDocument.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 251);
      return true;
    });
    const request = await startClientAction({ kind: "wait", selector: "#ready", timeoutMs: 250 });
    expect(request.settled).toHaveBeenCalledOnce();
    await expectClientError(request, "Timed out waiting for condition");
  });

  it("submits through the native key action", async () => {
    const typeResponse = await runAction({
      kind: "type",
      ref: "field-1",
      text: "hello",
      submit: true,
    });

    expect(typeResponse.statusCode).toBe(200);
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter" }),
    );
  });

  it("checks the bound document URL before evaluating a wait predicate", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce("https://example.com")
      .mockResolvedValueOnce({ kind: "result", ready: true });
    chromeMcpMocks.withChromeMcpDocument.mockImplementationOnce(
      async (_params, task) => await task({ evaluate }),
    );

    const response = await runAction({
      kind: "wait",
      fn: "() => Promise.resolve(document.title === 'ready')",
    });

    expect(response.statusCode).toBe(200);
    expect(evaluate).toHaveBeenCalledTimes(2);
    const script = String(evaluate.mock.calls[1]?.[0]);
    expect(script).toContain("document.title === 'ready'");
    expect(script).toContain("Boolean(await");
    expect(routeState.profileCtx.closeTab).not.toHaveBeenCalled();
  });

  it("rechecks a requested URL after a ready predicate mutates same-document history", async () => {
    chromeMcpMocks.withChromeMcpDocument.mockImplementation(async (_params, task) => {
      let urlReads = 0;
      return await task({
        evaluate: async (fn) => {
          if (!fn.includes("return boundDocument")) {
            return { kind: "result", ready: true };
          }
          urlReads += 1;
          if (urlReads === 2) {
            throw new Error("final URL rechecked");
          }
          return "https://example.com/ready";
        },
      });
    });

    await expectActionToThrow(
      {
        kind: "wait",
        url: "https://example.com/ready",
        fn: "() => { history.pushState({}, '', '/changed'); return true; }",
      },
      "final URL rechecked",
    );
  });

  it.each(TARGET_REFRESH_ACTIONS)(
    "does not adopt an unrelated target after native $kind interaction",
    async (body) => {
      routeState.profileCtx.listTabs
        .mockResolvedValueOnce([routeState.tab])
        .mockResolvedValue([{ targetId: "new-target", url: routeState.tab.url }]);

      const response = await runAction(body);

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        targetId: routeState.tab.targetId,
        url: routeState.tab.url,
      });
    },
  );

  it("propagates caller cancellation to the native action without changing its timeout", async () => {
    let operation: ChromeMcpOperationOptions | undefined;
    const pause = async (params: ChromeMcpOperationOptions) => {
      operation = params;
      await sleep(30_000, undefined, { signal: params.signal });
    };
    chromeMcpMocks.clickChromeMcpCoords.mockImplementationOnce(pause);
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    const ctrl = new AbortController();
    clientControllers.push(ctrl);
    const reason = new Error("caller cancelled the browser action");
    const completion = Promise.resolve(
      handler?.(
        {
          params: {},
          query: {},
          body: { kind: "clickCoords", x: 20, y: 30 },
          signal: ctrl.signal,
        },
        response.res,
      ),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(operation?.timeoutMs).toBe(60_000);
    expect(operation?.signal?.aborted).toBe(false);

    ctrl.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    expect(operation?.signal?.aborted).toBe(true);
    expect(operation?.signal?.reason).toBe(reason);
    expect(await completion).toBe(reason);
    expect(response.body).toBeUndefined();
  });

  it("cancels a pending existing-session wait when its request aborts", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    const ctrl = new AbortController();
    const pending = handler?.(
      {
        params: {},
        query: {},
        body: { kind: "wait", timeMs: 30_000 },
        signal: ctrl.signal,
      },
      response.res,
    );
    void pending?.catch(() => {});

    ctrl.abort(new Error("request cancelled after browser crash"));

    await expect(pending).rejects.toThrow(/aborted|cancelled/i);
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("normalizes statement-body evaluate sources before Chrome MCP execution", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(42 as never);

    const response = await runAction({
      kind: "evaluate",
      fn: "const value = 41; return value + 1;",
    });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        fn: "async () => {\nconst value = 41; return value + 1;\n}",
      }),
    );
  });

  it("normalizes ref-scoped statement-body evaluate sources before Chrome MCP execution", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce("Ada" as never);

    const response = await runAction({
      kind: "evaluate",
      ref: "7",
      fn: "const text = el.textContent; return text;",
    });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["7"],
        fn: "async (el) => {\nconst text = el.textContent; return text;\n}",
      }),
    );
  });

  it("returns the tab URL after a keypress", async () => {
    const response = await runAction({ kind: "press", key: "Enter" });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ ok: true, targetId: "7", url: "https://example.com" });
  });

  it("surfaces a native interaction failure", async () => {
    chromeMcpMocks.clickChromeMcpElement.mockImplementationOnce(() => {
      throw new Error("stale element");
    });

    await expectActionToThrow({ kind: "click", ref: "btn-1" }, "stale element");
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });
});
