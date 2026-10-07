import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

const current = new AsyncLocalStorage<{ key: string; active: boolean }>();
const lifetimes = new Map<string, ReturnType<typeof createLifetime>>();

function createLifetime({ admission }: OpenClawStateWorkerContext) {
  let work = new AsyncWorkScope();
  const scopes = new Set([work]);
  let gateways = 0;
  let closing = false;
  const drain = (scope: AsyncWorkScope) =>
    AsyncWorkScope.runWhenAllIdle(
      () => [scope],
      async () => {
        await scope.drain();
        scopes.delete(scope);
      },
    );
  const owner = {
    retainGateway() {
      if (closing) {
        work = new AsyncWorkScope();
        scopes.add(work);
        closing = false;
      }
      gateways += 1;
      let released = false;
      let pending: Promise<void> | undefined;
      const beginClose = () => {
        if (!released) {
          released = true;
          if (--gateways === 0) {
            closing = true;
            pending = drain(work);
          }
        }
      };
      return {
        beginClose,
        drain: () => {
          beginClose();
          return pending ?? Promise.resolve();
        },
      };
    },
    run<T>(run: () => Promise<T>) {
      if (closing) {
        return Promise.reject(new Error("Voice session persistence admission is closed"));
      }
      // Accepted writes keep their own live settlement scope across scheduler close.
      return work.track(run);
    },
  };
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (
        !identity ||
        identity.key === admission.identity.key ||
        identity.canonicalPath === admission.identity.canonicalPath
      ) {
        closing = true;
        await Promise.all([...scopes].map(drain));
        lifetimes.delete(admission.coordinationKey);
        unregister();
      }
    },
  });
  return owner;
}

function lifetime(context: OpenClawStateWorkerContext) {
  let owner = lifetimes.get(context.admission.coordinationKey);
  if (!owner) {
    owner = createLifetime(context);
    lifetimes.set(context.admission.coordinationKey, owner);
  }
  return owner;
}

export function withClientVoiceSessionSettlement<T>(run: () => Promise<T>): Promise<T> {
  const context = captureOpenClawStateWorkerContext();
  const key = context.admission.coordinationKey;
  const inherited = current.getStore();
  if (inherited) {
    if (!inherited.active || inherited.key !== key) {
      return Promise.reject(new Error("Voice session persistence lost its accepted owner"));
    }
    return trackAsyncWork(run);
  }
  const operation = { key, active: true };
  return lifetime(context).run(() =>
    current.run(operation, async () => {
      try {
        return await run();
      } finally {
        operation.active = false;
      }
    }),
  );
}

export function prepareClientVoiceSessionClose() {
  return lifetime(captureOpenClawStateWorkerContext()).retainGateway();
}
