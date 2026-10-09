import { AsyncLocalStorage } from "node:async_hooks";
import type {
  PreparedModelRuntimeSnapshot,
  PreparedReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.types.js";

type PreparedReplyDispatchScope = Readonly<{
  runtime: PreparedReplyDispatchRuntime;
  borrowSnapshot?: () => PreparedModelRuntimeSnapshot | undefined;
}>;

const preparedReplyDispatchRuntime = new AsyncLocalStorage<
  PreparedReplyDispatchScope | undefined
>();

/** Keeps the configured Gateway generation request-scoped without widening the public resolver. */
export function bindPreparedReplyDispatchRuntime<Args extends unknown[], Result>(
  runtime: PreparedReplyDispatchRuntime | undefined,
  run: (...args: Args) => Result,
  borrowSnapshot?: () => PreparedModelRuntimeSnapshot | undefined,
): (...args: Args) => Result {
  const scope = runtime ? { runtime, borrowSnapshot } : undefined;
  return (...args) => preparedReplyDispatchRuntime.run(scope, () => run(...args));
}

export function getPreparedReplyDispatchRuntime(): PreparedReplyDispatchRuntime | undefined {
  return preparedReplyDispatchRuntime.getStore()?.runtime;
}

/** The dispatch-held snapshot the turn's run lease may borrow after a newer publication. */
export function getPreparedReplyDispatchSnapshotBorrow():
  | (() => PreparedModelRuntimeSnapshot | undefined)
  | undefined {
  return preparedReplyDispatchRuntime.getStore()?.borrowSnapshot;
}
