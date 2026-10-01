/**
 * Shared by the tool schema and runtime action handlers so model-facing limits
 * and browser-control enforcement stay aligned.
 */
import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  MAX_TIMER_TIMEOUT_MS,
  parseStrictInteger,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserActRequest } from "./client-actions.types.js";
import { DEFAULT_BROWSER_ACTION_TIMEOUT_MS } from "./constants.js";
import { normalizeBrowserTimerDelayMs } from "./timer-delay.js";

export const ACT_MAX_BATCH_ACTIONS = 100;
export const ACT_MAX_BATCH_DEPTH = 5;
export const ACT_MAX_CLICK_DELAY_MS = 5_000;
export const ACT_MAX_WAIT_TIME_MS = 30_000;
export const ACT_MAX_VIEWPORT_DIMENSION = 8192;
/** Existing-session actions whose runtime accepts a per-call timeout override. */
export const EXISTING_SESSION_TIMEOUT_OVERRIDE_KINDS: ReadonlySet<BrowserActRequest["kind"]> =
  new Set(["click", "clickCoords", "evaluate", "wait"]);

const ACT_MIN_TIMEOUT_MS = 500;
const ACT_MAX_INTERACTION_TIMEOUT_MS = 60_000;
const ACT_MAX_WAIT_TIMEOUT_MS = 120_000;
const ACT_DEFAULT_INTERACTION_TIMEOUT_MS = 8_000;
const ACT_DEFAULT_WAIT_TIMEOUT_MS = 20_000;

/** Grace between the runtime's action budget and an outer transport watchdog. */
export const BROWSER_ACTION_TRANSPORT_SLACK_MS = 5_000;
/** Window for a native download event to arrive after its initiating action. */
export const BROWSER_ACTION_DOWNLOAD_GRACE_MS = 250;
/** Keep navigation timeouts consistent across transports and browser backends. */
export function resolveBrowserNavigationTimeoutMs(timeoutMs?: number): number {
  return Math.min(120_000, resolveTimerTimeoutMs(timeoutMs, 20_000, 1_000));
}

export function normalizeActBoundedNonNegativeMs(
  value: number | undefined,
  fieldName: string,
  maxMs: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be >= 0`);
  }
  const normalized = Math.floor(value);
  if (normalized > maxMs) {
    throw new Error(`${fieldName} exceeds maximum of ${maxMs}ms`);
  }
  return normalized;
}

/** Clamp interaction actions to the supported browser-control timeout window. */
export function resolveActInteractionTimeoutMs(timeoutMs?: number): number {
  return Math.min(
    ACT_MAX_INTERACTION_TIMEOUT_MS,
    resolveTimerTimeoutMs(timeoutMs, ACT_DEFAULT_INTERACTION_TIMEOUT_MS, ACT_MIN_TIMEOUT_MS),
  );
}

/** Clamp wait actions to their wider supported browser-control timeout window. */
export function resolveActWaitTimeoutMs(timeoutMs?: number): number {
  return Math.min(
    ACT_MAX_WAIT_TIMEOUT_MS,
    resolveTimerTimeoutMs(timeoutMs, ACT_DEFAULT_WAIT_TIMEOUT_MS, ACT_MIN_TIMEOUT_MS),
  );
}

function parseTimerInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : parseStrictInteger(value);
}

function resolveNonNegativeTimerMs(value: unknown): number {
  const parsed = parseTimerInteger(value);
  return parsed !== undefined && parsed >= 0 ? resolveTimerTimeoutMs(parsed, 0, 0) : 0;
}

function addExecutionBudgetMs(totalMs: number, nextMs: number): number {
  return Math.min(MAX_TIMER_TIMEOUT_MS, totalMs + nextMs);
}

function multiplyExecutionBudgetMs(durationMs: number, count: number): number {
  return Math.min(MAX_TIMER_TIMEOUT_MS, durationMs * count);
}

function resolveInteractionTimeoutMs(request: BrowserActRequest): number {
  return resolveActInteractionTimeoutMs(
    parseTimerInteger("timeoutMs" in request ? request.timeoutMs : undefined),
  );
}

/** One capture owner drains native downloads after the complete action or batch. */
export function browserActMayStartDownload(request: BrowserActRequest): boolean {
  if (request.kind === "batch") {
    const actions = Array.isArray(request.actions) ? request.actions.filter(isRecord) : [];
    return actions.some(browserActMayStartDownload);
  }
  if (request.kind === "wait") {
    return typeof request.fn === "string" && Boolean(request.fn.trim());
  }
  return request.kind !== "close" && request.kind !== "resize";
}

function resolveLeafExecutionBudgetMs(
  request: Exclude<BrowserActRequest, { kind: "batch" | "wait" }>,
): number {
  switch (request.kind) {
    case "click": {
      const timeoutMs = resolveInteractionTimeoutMs(request);
      const delayMs = Math.min(ACT_MAX_CLICK_DELAY_MS, resolveNonNegativeTimerMs(request.delayMs));
      return delayMs > 0 ? addExecutionBudgetMs(timeoutMs * 2, delayMs) : timeoutMs;
    }
    case "clickCoords": {
      const delayMs = Math.min(ACT_MAX_CLICK_DELAY_MS, resolveNonNegativeTimerMs(request.delayMs));
      const explicitTimeoutMs =
        clampPositiveTimerTimeoutMs(parseTimerInteger(request.timeoutMs)) ?? 0;
      return addExecutionBudgetMs(
        explicitTimeoutMs,
        multiplyExecutionBudgetMs(delayMs, request.doubleClick ? 3 : 1),
      );
    }
    case "type": {
      const phaseCount = (request.slowly ? 2 : 1) + (request.submit ? 1 : 0);
      return multiplyExecutionBudgetMs(resolveInteractionTimeoutMs(request), phaseCount);
    }
    case "press":
      return resolveNonNegativeTimerMs(request.delayMs);
    case "insertText":
      return 0;
    case "fill": {
      const fields = Array.isArray(request.fields) ? request.fields : [];
      const fieldCount = fields.filter(
        (field) =>
          Boolean(field) &&
          typeof field === "object" &&
          typeof field.ref === "string" &&
          Boolean(field.ref.trim()),
      ).length;
      return multiplyExecutionBudgetMs(resolveInteractionTimeoutMs(request), fieldCount);
    }
    case "evaluate":
    case "scrollIntoView":
      return resolveActWaitTimeoutMs(parseTimerInteger(request.timeoutMs));
    case "hover":
    case "drag":
    case "select":
      return resolveInteractionTimeoutMs(request);
    case "resize":
    case "close":
      return 0;
  }
  return 0;
}

function resolveExecutionBudgetMs(request: BrowserActRequest): number {
  if (request.kind === "batch") {
    // Model-facing schemas keep child actions permissive for provider compatibility.
    // Budget valid entries only; the browser route remains the validation owner.
    const actions = Array.isArray(request.actions) ? request.actions.filter(isRecord) : [];
    return actions.reduce(
      (totalMs, action) => addExecutionBudgetMs(totalMs, resolveExecutionBudgetMs(action)),
      0,
    );
  }
  if (request.kind !== "wait") {
    return resolveLeafExecutionBudgetMs(request);
  }
  // Text locators accept whitespace as content; selector, URL, and function
  // waits normalize it away. Keep this in lockstep with waitForViaPlaywright.
  const conditionCount = [
    Boolean(request.text),
    Boolean(request.textGone),
    typeof request.selector === "string" && Boolean(request.selector.trim()),
    typeof request.url === "string" && Boolean(request.url.trim()),
    Boolean(request.loadState),
    typeof request.fn === "string" && Boolean(request.fn.trim()),
  ].filter(Boolean).length;
  const timeoutMs = resolveActWaitTimeoutMs(parseTimerInteger(request.timeoutMs));
  return addExecutionBudgetMs(
    resolveNonNegativeTimerMs(request.timeMs),
    multiplyExecutionBudgetMs(timeoutMs, conditionCount),
  );
}

/** Bound the logical action without renewing every MCP call's budget. */
export function resolveExistingSessionActTimeouts(request: BrowserActRequest) {
  const requestedTimeoutMs =
    EXISTING_SESSION_TIMEOUT_OVERRIDE_KINDS.has(request.kind) && "timeoutMs" in request
      ? parseTimerInteger(request.timeoutMs)
      : undefined;
  const timeoutMs = normalizeBrowserTimerDelayMs(
    requestedTimeoutMs ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  );
  let actionTimeoutMs = timeoutMs;
  if (request.kind === "wait") {
    const timeMs = resolveNonNegativeTimerMs(request.timeMs);
    const hasCondition = [
      request.text,
      request.textGone,
      request.selector,
      request.url,
      request.loadState,
      request.fn,
    ].some((value) => typeof value === "string" && Boolean(value.trim()));
    actionTimeoutMs = hasCondition
      ? addExecutionBudgetMs(timeMs, Math.max(250, timeoutMs))
      : Math.max(timeMs, timeoutMs);
  }
  return {
    timeoutMs,
    // Waits own their delay and condition deadlines; only the request bounds preparation.
    bodyTimeoutMs: request.kind === "wait" ? undefined : actionTimeoutMs,
    // A wait can consume its entire delay/condition budget. Let that owner settle
    // before the request watchdog fires, as with the outer client transport.
    requestTimeoutMs:
      request.kind === "wait"
        ? addExecutionBudgetMs(actionTimeoutMs, BROWSER_ACTION_TRANSPORT_SLACK_MS)
        : actionTimeoutMs,
  };
}

/**
 * Resolve the runtime budget before an outer transport watchdog is armed.
 * Wait phases and batch children execute serially, so maxima would abort valid work midway.
 */
function resolveBrowserActExecutionBudgetMs(request: BrowserActRequest): number {
  const executionBudgetMs = addExecutionBudgetMs(
    resolveExecutionBudgetMs(request),
    browserActMayStartDownload(request) ? BROWSER_ACTION_DOWNLOAD_GRACE_MS : 0,
  );
  if (request.kind === "wait") {
    return executionBudgetMs;
  }
  const explicitTimeoutMs =
    request.kind === "batch"
      ? undefined
      : clampPositiveTimerTimeoutMs(
          parseTimerInteger("timeoutMs" in request ? request.timeoutMs : undefined),
        );
  return explicitTimeoutMs === undefined
    ? Math.max(DEFAULT_BROWSER_ACTION_TIMEOUT_MS, executionBudgetMs)
    : executionBudgetMs;
}

/** Add action transport slack once after the full sequential runtime budget is known. */
export function resolveBrowserActRequestTimeoutMs(request: BrowserActRequest): number {
  const existingSessionBudgetMs =
    request.kind === "batch" ? 0 : resolveExistingSessionActTimeouts(request).requestTimeoutMs;
  return (
    addTimerTimeoutGraceMs(
      Math.max(resolveBrowserActExecutionBudgetMs(request), existingSessionBudgetMs),
      BROWSER_ACTION_TRANSPORT_SLACK_MS,
    ) ?? 1
  );
}
