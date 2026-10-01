import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import type { Page } from "playwright-core";
import { normalizeActBoundedNonNegativeMs } from "./act-policy.js";
import {
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
  markObservedDialogsHandledRemotelyForPage,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import { toAIFriendlyError } from "./pw-tools-core.shared.js";

export type InteractionTargetOptions = {
  cdpUrl: string;
  ssrfPolicy?: SsrFPolicy;
  browserFilesystemLocal?: boolean;
  targetId?: string;
  assertCurrent?: () => void | Promise<void>;
};

export type AbortableInteractionOptions = InteractionTargetOptions & { signal?: AbortSignal };
export type ElementInteractionOptions = AbortableInteractionOptions & {
  ref?: string;
  selector?: string;
  timeoutMs?: number;
};

export class BrowserInteractionAuthorityError extends Error {
  constructor(error: unknown) {
    const cause = toErrorObject(error, "Browser interaction authority changed");
    super(cause.message, { cause });
    this.name = "BrowserInteractionAuthorityError";
  }
}

export function assertInteractionCurrent(
  opts: Pick<InteractionTargetOptions, "assertCurrent">,
): void | Promise<void> {
  const reject = (error: unknown): never => {
    // Authority loss is fatal even inside a batch configured to continue on errors.
    throw new BrowserInteractionAuthorityError(error);
  };
  try {
    // Preserve a resident assertion's synchronous fence through native action dispatch.
    const assertion = opts.assertCurrent?.();
    return assertion ? assertion.catch(reject) : undefined;
  } catch (error) {
    reject(error);
  }
}

export function resolveBoundedDelayMs(
  value: number | undefined,
  label: string,
  maxMs: number,
): number {
  return normalizeActBoundedNonNegativeMs(Math.floor(value ?? 0), label, maxMs) ?? 0;
}

export async function getRestoredPageForTarget(opts: InteractionTargetOptions) {
  const page = await getPageForTargetId(opts);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  return page;
}

export function toFriendlyInteractionError(err: unknown, label: string): Error {
  return isBrowserObservedDialogBlockedError(err) || err instanceof BrowserInteractionAuthorityError
    ? err
    : toAIFriendlyError(err, label);
}

export function reconcileRemoteDialogAfterActionSettled(page: Page, signal?: AbortSignal): void {
  if (isBrowserObservedDialogBlockedError(signal?.reason)) {
    markObservedDialogsHandledRemotelyForPage(page, signal.reason.browserState.dialogs.pending);
  }
}

export function throwIfInteractionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection");
  }
}

export async function runCancellablePageInteraction<T>(
  page: Page,
  opts: AbortableInteractionOptions,
  action: (signal: AbortSignal) => Promise<T>,
  errorLabel?: string,
): Promise<T> {
  const cancellation = new AbortController();
  const interruption = new AbortController();
  const onAbort = () => {
    // Dialogs interrupt the foreground call while the native action remains live.
    // Caller cancellation must join the native call.
    const controller = isBrowserObservedDialogBlockedError(opts.signal?.reason)
      ? interruption
      : cancellation;
    controller.abort(opts.signal?.reason);
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) {
    onAbort();
  }
  const { abortPromise, cleanup } = createAbortPromiseWithListener(interruption.signal);
  try {
    const result = await awaitInteractionWithAbort(
      {
        action: () => action(cancellation.signal),
        assertCurrent: opts.assertCurrent,
      },
      abortPromise,
      opts.signal,
      () => reconcileRemoteDialogAfterActionSettled(page, opts.signal),
    );
    throwIfInteractionAborted(opts.signal);
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError" &&
      error.cause === cancellation.signal.reason
    ) {
      throwIfInteractionAborted(cancellation.signal);
    }
    throw errorLabel === undefined ? error : toFriendlyInteractionError(error, errorLabel);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    cleanup();
  }
}

export async function awaitActionWithAbort<T>(
  actionPromise: Promise<T>,
  abortPromise?: Promise<never>,
  onActionResolvedAfterAbort?: () => void,
): Promise<T> {
  if (!abortPromise) {
    return await actionPromise;
  }
  try {
    return await Promise.race([actionPromise, abortPromise]);
  } catch (err) {
    // If abort wins the race, the action may reject later; avoid unhandled rejections.
    void actionPromise.then(
      () => onActionResolvedAfterAbort?.(),
      () => {},
    );
    throw err;
  }
}

export async function awaitInteractionWithAbort<T>(
  opts: { action: () => Promise<T>; assertCurrent?: InteractionTargetOptions["assertCurrent"] },
  abortPromise?: Promise<never>,
  signal?: AbortSignal,
  onActionResolvedAfterAbort?: () => void,
): Promise<T> {
  const action = (async () => {
    // A resident authority assertion must fence native dispatch synchronously.
    const assertion = assertInteractionCurrent(opts);
    if (assertion) {
      await assertion;
    }
    throwIfInteractionAborted(signal);
    return await opts.action();
  })();
  return await awaitActionWithAbort(action, abortPromise, onActionResolvedAfterAbort);
}

export function createAbortPromiseWithListener(
  signal?: AbortSignal,
  onAbort?: (reason: unknown) => void,
): {
  abortPromise?: Promise<never>;
  cleanup: () => void;
} {
  if (!signal) {
    return { cleanup: () => {} };
  }
  const abortError = () => {
    onAbort?.(signal.reason);
    return toErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection");
  };
  let abortListener: (() => void) | undefined;
  const abortPromise: Promise<never> = signal.aborted
    ? Promise.reject(abortError())
    : new Promise((_, reject) => {
        abortListener = () => reject(abortError());
        signal.addEventListener("abort", abortListener, { once: true });
      });
  // Avoid unhandled rejections on early returns.
  void abortPromise.catch(() => {});
  return {
    abortPromise,
    cleanup: () => {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    },
  };
}
