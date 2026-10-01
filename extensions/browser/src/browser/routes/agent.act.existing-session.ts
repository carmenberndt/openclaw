/** Existing-session action waits and deadline ownership. */
import { setTimeout as sleep } from "node:timers/promises";
import type { ChromeMcpTargetOperation } from "../chrome-mcp-contracts.js";
import { ChromeMcpDocumentUnavailableError, withChromeMcpDocument } from "../chrome-mcp.js";
import { normalizeBrowserEvaluateFunctionSource } from "../evaluate-source.js";
import { matchBrowserUrlPattern } from "../url-pattern.js";

/** Abort nested operations without racing the route's response/error owner. */
export function createExistingSessionDeadline(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  label: string | Error,
) {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  const error =
    typeof label === "string" ? new Error(`${label} timed out after ${timeoutMs}ms`) : label;
  const deadlineAt = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(error), timeoutMs);
  timer.unref?.();
  return {
    signal,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    throwIfAborted: () => {
      // A busy event loop must not turn a late completion into a successful action.
      if (Date.now() >= deadlineAt && !signal.aborted) {
        controller.abort(error);
      }
      signal.throwIfAborted();
    },
    cleanup: () => clearTimeout(timer),
  };
}

function buildExistingSessionWaitPredicate(params: {
  text?: string;
  textGone?: string;
  selector?: string;
  loadState?: "load" | "domcontentloaded" | "networkidle";
  fn?: string;
}): string | null {
  const checks = [
    params.text && `Boolean(document.body?.innerText?.includes(${JSON.stringify(params.text)}))`,
    params.textGone && `!document.body?.innerText?.includes(${JSON.stringify(params.textGone)})`,
    params.selector &&
      `(function visible(node) {
      if (!node) return false;
      if (node.nodeType === 1) {
        // Like managed waits, display:contents is visible through rendered children.
        if (getComputedStyle(node).display === "contents") {
          return Array.from(node.childNodes).some(visible);
        }
        if (!node.checkVisibility({ visibilityProperty: true })) return false;
      } else if (node.nodeType !== 3) {
        return false;
      }
      const range = document.createRange();
      range.selectNode(node);
      const rect = node.nodeType === 1 ? node.getBoundingClientRect() : range.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })(document.querySelector(${JSON.stringify(params.selector)}))`,
    params.loadState === "domcontentloaded" &&
      `document.readyState === "interactive" || document.readyState === "complete"`,
    params.loadState === "load" && `document.readyState === "complete"`,
    // `fn` is admitted only by the same evaluateEnabled gate as evaluate.
    // Preserve its async semantics; document binding guards scheduler rebinding.
    params.fn && `Boolean(await (${normalizeBrowserEvaluateFunctionSource(params.fn)})())`,
  ];
  return (
    checks
      .filter(Boolean)
      .map((check) => `(${check})`)
      .join(" && ") || null
  );
}

export async function waitForExistingSessionCondition(
  params: ChromeMcpTargetOperation & {
    timeMs?: number;
    text?: string;
    textGone?: string;
    selector?: string;
    url?: string;
    loadState?: "load" | "domcontentloaded" | "networkidle";
    fn?: string;
  },
): Promise<void> {
  if (params.timeMs && params.timeMs > 0) {
    await sleep(params.timeMs, undefined, { signal: params.signal });
  }
  const predicate = buildExistingSessionWaitPredicate(params);
  if (!predicate && !params.url) {
    return;
  }
  const timeoutMs = Math.max(250, params.timeoutMs ?? 10_000);
  const timeoutError = new Error("Timed out waiting for condition");
  const deadline = createExistingSessionDeadline(timeoutMs, params.signal, timeoutError);
  const { signal } = deadline;
  try {
    while (deadline.remainingMs() > 0) {
      try {
        const ready = await withChromeMcpDocument({ ...params, signal }, async (document) => {
          deadline.throwIfAborted();
          const readCurrentUrl = async () => {
            deadline.throwIfAborted();
            const url = await document.evaluate(`(root) => {
            const boundDocument = root?.nodeType === 9 ? root : root?.ownerDocument;
            return boundDocument === document ? location.href : null;
          }`);
            deadline.throwIfAborted();
            if (typeof url !== "string" || !url.trim()) {
              return null;
            }
            return url;
          };
          const currentUrl = await readCurrentUrl();
          if (!currentUrl) {
            return false;
          }
          if (params.url && !matchBrowserUrlPattern(params.url, currentUrl)) {
            return false;
          }
          if (!predicate) {
            return true;
          }
          deadline.throwIfAborted();
          const outcome = await document.evaluate(`async (root) => {
          const boundDocument = root?.nodeType === 9 ? root : root?.ownerDocument;
          if (boundDocument !== document || location.href !== ${JSON.stringify(currentUrl)}) {
            return { kind: "navigation" };
          }
          try {
            return { kind: "result", ready: Boolean(await (${predicate})) };
          } catch (error) {
            const message = error && typeof error === "object" && "message" in error
              ? String(error.message)
              : String(error);
            return { kind: "error", message };
          }
        }`);
          deadline.throwIfAborted();
          if (!outcome || typeof outcome !== "object") {
            throw new Error("Document-bound wait returned an invalid result");
          }
          if ("kind" in outcome && outcome.kind === "error") {
            throw new Error(
              "message" in outcome && typeof outcome.message === "string"
                ? outcome.message
                : "Wait predicate failed",
            );
          }
          const predicateReady =
            "kind" in outcome &&
            outcome.kind === "result" &&
            "ready" in outcome &&
            outcome.ready === true;
          if (!predicateReady || !params.url) {
            return predicateReady;
          }
          const finalUrl = await readCurrentUrl();
          return finalUrl !== null && matchBrowserUrlPattern(params.url, finalUrl);
        });
        deadline.throwIfAborted();
        if (ready) {
          return;
        }
      } catch (error) {
        deadline.throwIfAborted();
        if (!(error instanceof ChromeMcpDocumentUnavailableError)) {
          throw error;
        }
      }
      await sleep(Math.min(250, deadline.remainingMs()), undefined, { signal }).catch(
        (error: unknown) => {
          deadline.throwIfAborted();
          throw error;
        },
      );
    }
    throw timeoutError;
  } finally {
    deadline.cleanup();
  }
}
