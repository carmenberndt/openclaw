import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import type { Frame, Page } from "playwright-core";
import {
  ACT_MAX_BATCH_ACTIONS,
  ACT_MAX_BATCH_DEPTH,
  BROWSER_ACTION_DOWNLOAD_GRACE_MS,
  browserActMayStartDownload,
} from "./act-policy.js";
import type { BrowserBatchAbort, BrowserBatchActionResult } from "./client-actions-types.js";
import type { BrowserActRequest } from "./client-actions.types.js";
import type { BrowserDownloadResult } from "./download-types.js";
import { pageTargetInfo } from "./pw-session-connection.js";
import {
  beginActionDownloadCaptureOnPage,
  createObservedDialogAbortSignalForPage,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
} from "./pw-session.js";
import {
  clickCoordsViaPlaywright,
  clickViaPlaywright,
  dragViaPlaywright,
  evaluateViaPlaywright,
  fillFormViaPlaywright,
  hoverViaPlaywright,
  insertTextViaPlaywright,
  pressKeyViaPlaywright,
  scrollIntoViewViaPlaywright,
  selectOptionViaPlaywright,
  typeViaPlaywright,
} from "./pw-tools-core.interactions.actions.js";
import { waitForViaPlaywright } from "./pw-tools-core.interactions.content.js";
import {
  assertInteractionCurrent,
  BrowserInteractionAuthorityError,
  type AbortableInteractionOptions,
} from "./pw-tools-core.interactions.navigation.js";
import { closePageViaPlaywright, resizeViewportViaPlaywright } from "./pw-tools-core.snapshot.js";

const ACT_DOWNLOAD_MAX_DRAIN_MS = 1_000;

async function executeSingleAction(
  opts: AbortableInteractionOptions & {
    action: BrowserActRequest;
    evaluateEnabled?: boolean;
    depth?: number;
  },
): Promise<unknown> {
  const { action, cdpUrl, targetId, evaluateEnabled, ssrfPolicy, signal, assertCurrent } = opts;
  const depth = opts.depth ?? 0;
  if (depth > ACT_MAX_BATCH_DEPTH) {
    throw new Error(`Batch nesting depth exceeds maximum of ${ACT_MAX_BATCH_DEPTH}`);
  }
  const effectiveTargetId = action.targetId ?? targetId;
  const interaction = {
    cdpUrl,
    targetId: effectiveTargetId,
    ssrfPolicy,
    signal,
    assertCurrent,
  };
  if (assertCurrent) {
    const assertion = assertInteractionCurrent(interaction);
    if (assertion) {
      await assertion;
    }
  }
  switch (action.kind) {
    case "click":
      return await clickViaPlaywright({
        ...action,
        ...interaction,
        button: action.button as "left" | "right" | "middle" | undefined,
        modifiers: action.modifiers as Array<
          "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift"
        >,
      });
    case "clickCoords":
      return await clickCoordsViaPlaywright({
        ...action,
        ...interaction,
        button: action.button as "left" | "right" | "middle" | undefined,
      });
    case "type":
      return await typeViaPlaywright({ ...action, ...interaction });
    case "insertText":
      return await insertTextViaPlaywright({ ...action, ...interaction });
    case "press":
      return await pressKeyViaPlaywright({ ...action, ...interaction });
    case "hover":
      return await hoverViaPlaywright({ ...action, ...interaction });
    case "scrollIntoView":
      return await scrollIntoViewViaPlaywright({ ...action, ...interaction });
    case "drag":
      return await dragViaPlaywright({ ...action, ...interaction });
    case "select":
      return await selectOptionViaPlaywright({ ...action, ...interaction });
    case "fill":
      return await fillFormViaPlaywright({ ...action, ...interaction });
    case "resize":
      return await resizeViewportViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        width: action.width,
        height: action.height,
        signal,
        assertCurrent,
      });
    case "wait":
      if (action.fn && !evaluateEnabled) {
        throw new Error("wait --fn is disabled by config (browser.evaluateEnabled=false)");
      }
      return await waitForViaPlaywright({ ...action, ...interaction });
    case "evaluate":
      if (!evaluateEnabled) {
        throw new Error("act:evaluate is disabled by config (browser.evaluateEnabled=false)");
      }
      return await evaluateViaPlaywright({ ...action, ...interaction });
    case "close":
      return await closePageViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        assertCurrent,
      });
    case "batch": {
      const batch = await batchViaPlaywright({
        ...action,
        ...interaction,
        evaluateEnabled,
        depth: depth + 1,
      });
      // A nested batch is one parent action; surface its first failure so each
      // level applies its own stopOnError without discarding the child outcome.
      const failure = batch.results.find((result) => !result.ok);
      if (failure) {
        throw new Error(failure.error);
      }
      break;
    }
    default:
      throw new Error(`Unsupported batch action kind: ${(action as { kind: string }).kind}`);
  }
  return undefined;
}

export async function executeActViaPlaywright(
  opts: AbortableInteractionOptions & {
    action: BrowserActRequest;
    evaluateEnabled?: boolean;
  },
): Promise<{
  result?: unknown;
  results?: BrowserBatchActionResult[];
  aborted?: BrowserBatchAbort;
  blockedByDialog?: boolean;
  browserState?: unknown;
  downloads?: BrowserDownloadResult[];
  targetId?: string;
}> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  const withOperationTarget = async <T extends Record<string, unknown>>(payload: T) => {
    const targetId = (await pageTargetInfo(page).catch(() => null))?.targetId;
    return { ...payload, ...(targetId ? { targetId } : {}) };
  };
  // Any DOM action can trigger a download. Capture it through the native Page event.
  const downloadCapture = beginActionDownloadCaptureOnPage(page);
  const downloadGraceMs = browserActMayStartDownload(opts.action)
    ? BROWSER_ACTION_DOWNLOAD_GRACE_MS
    : 0;
  const drainDownloads = async (firstEventGraceMs = downloadGraceMs) =>
    await downloadCapture.drain({
      firstEventGraceMs,
      maxWaitMs: ACT_DOWNLOAD_MAX_DRAIN_MS,
      quietMs: BROWSER_ACTION_DOWNLOAD_GRACE_MS,
    });
  const dialogAbort = createObservedDialogAbortSignalForPage({
    page,
    parentSignal: opts.signal,
  });
  try {
    if (opts.action.kind === "batch") {
      const batch = await batchViaPlaywright({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        page,
        ssrfPolicy: opts.ssrfPolicy,
        actions: opts.action.actions,
        stopOnError: opts.action.stopOnError,
        evaluateEnabled: opts.evaluateEnabled,
        signal: dialogAbort.signal,
        assertCurrent: opts.assertCurrent,
      });
      const newDownloads = await drainDownloads();
      return await withOperationTarget({
        results: batch.results,
        ...(batch.aborted ? { aborted: batch.aborted } : {}),
        ...(newDownloads ? { downloads: newDownloads } : {}),
      });
    }
    const result = await executeSingleAction({ ...opts, signal: dialogAbort.signal });
    const newDownloads = await drainDownloads();
    return await withOperationTarget({
      ...(opts.action.kind === "evaluate" ? { result } : {}),
      ...(newDownloads ? { downloads: newDownloads } : {}),
    });
  } catch (err) {
    let failure = err;
    try {
      await drainDownloads();
    } catch (downloadErr) {
      // A download save failure is the action's network-to-file result;
      // preserve it even when the initiating interaction also failed.
      failure = downloadErr;
    }
    if (isBrowserObservedDialogBlockedError(failure)) {
      return await withOperationTarget({
        blockedByDialog: true,
        browserState: failure.browserState,
      });
    }
    throw failure;
  } finally {
    downloadCapture.dispose();
    dialogAbort.cleanup();
  }
}

async function batchViaPlaywright(
  opts: AbortableInteractionOptions & {
    actions: BrowserActRequest[];
    stopOnError?: boolean;
    evaluateEnabled?: boolean;
    depth?: number;
    page?: Page;
  },
): Promise<{ results: BrowserBatchActionResult[]; aborted?: BrowserBatchAbort }> {
  const depth = opts.depth ?? 0;
  if (depth > ACT_MAX_BATCH_DEPTH) {
    throw new Error(`Batch nesting depth exceeds maximum of ${ACT_MAX_BATCH_DEPTH}`);
  }
  if (opts.actions.length > ACT_MAX_BATCH_ACTIONS) {
    throw new Error(`Batch exceeds maximum of ${ACT_MAX_BATCH_ACTIONS} actions`);
  }
  const page = opts.page ?? (await getPageForTargetId(opts));
  const results: BrowserBatchActionResult[] = [];
  const finishAborted = (
    reason: BrowserBatchAbort["reason"],
    afterAction: number,
    url: string,
    skipped: number,
  ) =>
    skipped === 0
      ? { results }
      : { results, aborted: { reason, afterAction, url, skipped } satisfies BrowserBatchAbort };
  let mainFrameNavigations = 0;
  let navigationsAtLastDispatch = 0;
  const onFrameNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) {
      mainFrameNavigations += 1;
    }
  };
  const finishNavigation = (afterAction: number, skipped: number) => {
    const url = page.url();
    const lastResult = results.at(-1);
    if (lastResult) {
      results[results.length - 1] = { ...lastResult, navigated: true, url };
    }
    return finishAborted("navigation", afterAction, url, skipped);
  };

  // Snapshot refs are document-scoped, so any committed main-frame navigation
  // ends the batch. A commit after the next action dispatch is inherently unguardable;
  // callers that expect navigation can use separate act calls as the escape hatch.
  page.on("framenavigated", onFrameNavigated);
  try {
    for (const [index, action] of opts.actions.entries()) {
      if (opts.signal?.aborted) {
        throw opts.signal.reason ?? new Error("aborted");
      }
      if (mainFrameNavigations > navigationsAtLastDispatch) {
        return finishNavigation(index, opts.actions.length - index);
      }
      if (page.isClosed()) {
        return finishAborted("closed", index, page.url(), opts.actions.length - index);
      }
      navigationsAtLastDispatch = mainFrameNavigations;
      let result: BrowserBatchActionResult;
      try {
        await executeSingleAction({ ...opts, action, depth });
        result = { ok: true };
      } catch (err) {
        if (
          isBrowserObservedDialogBlockedError(err) ||
          err instanceof BrowserInteractionAuthorityError
        ) {
          throw err;
        }
        result = { ok: false, error: formatErrorMessage(err) };
      }
      results.push(result);
      if (page.isClosed()) {
        return finishAborted("closed", index + 1, page.url(), opts.actions.length - index - 1);
      }
      if (mainFrameNavigations > navigationsAtLastDispatch) {
        return finishNavigation(index + 1, opts.actions.length - index - 1);
      }
      if (!result.ok && opts.stopOnError !== false) {
        break;
      }
    }
    return { results };
  } finally {
    page.off("framenavigated", onFrameNavigated);
  }
}
