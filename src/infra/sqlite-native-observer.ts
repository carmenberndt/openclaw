import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { hasErrnoCode } from "./errno.js";
import { classifySqliteMutation } from "./sqlite-schema-mutation.js";

declare module "node:sqlite" {
  interface StatementSync {
    /** Node 26.8+ supports finalization; older supported runtimes omit this method. */
    close?(): void;
    [Symbol.dispose]?(): void;
  }
}

export type SqliteIteratorBehavior = Readonly<{
  nextAfterDoneIsTerminal: boolean;
  returnAfterDoneIsInert: boolean;
}>;
export type NativeSqlite = Pick<typeof import("node:sqlite"), "DatabaseSync" | "StatementSync"> & {
  iteratorBehavior: SqliteIteratorBehavior;
};

/** The runtime owner reuses its prepared one-row library probe, once per process load. */
export function probeSqliteIteratorBehavior(statement: StatementSync): SqliteIteratorBehavior {
  const previous = statement.iterate();
  previous.next();
  previous.next();
  const nextAfterDoneIsTerminal = previous.next().done === true;
  previous.return?.();
  const current = statement.iterate();
  try {
    current.next();
    previous.return?.();
    return { nextAfterDoneIsTerminal, returnAfterDoneIsInert: current.next().done === true };
  } finally {
    current.return?.();
  }
}
export type SqliteNativeMutation = ReturnType<typeof classifySqliteMutation>;
type NativePhase = "execute" | "bind" | "iterate";
type NativeOperation = {
  finish: (succeeded: boolean, abandoned?: boolean) => void;
  stepped?: () => void;
  expire?: () => void;
};
type IteratorLifetime = {
  observed?: NativeOperation;
  finished: boolean;
  invalidated: boolean;
  finish: (succeeded?: boolean, abandoned?: boolean) => void;
  invalidate: () => void;
  pause: () => void;
  expire: () => void;
  stopObservation: (succeeded?: boolean, abandoned?: boolean) => void;
};

const iteratorFinalizer = new FinalizationRegistry<Set<IteratorLifetime>>((lifetimes) => {
  for (const lifetime of lifetimes) {
    lifetime.finish(false, true);
  }
});

// Finalizer holdings must not share a closure with the statement or its bound methods.
function createIteratorLifetime(
  active: Set<IteratorLifetime>,
  activeIterators: Set<IteratorLifetime>,
): IteratorLifetime {
  const lifetime: IteratorLifetime = {
    finished: false,
    invalidated: false,
    expire: () => lifetime.observed?.expire?.(),
    pause: () => lifetime.stopObservation(),
    invalidate: () => {
      lifetime.invalidated = true;
      lifetime.finish();
    },
    stopObservation: (succeeded = false, abandoned = false) => {
      const previous = lifetime.observed;
      lifetime.observed = undefined;
      activeIterators.delete(lifetime);
      previous?.finish(succeeded, abandoned);
    },
    finish: (succeeded = false, abandoned = false) => {
      if (!lifetime.finished) {
        lifetime.finished = true;
        active.delete(lifetime);
        lifetime.stopObservation(succeeded, abandoned);
      }
    },
  };
  active.add(lifetime);
  return lifetime;
}
const bindingMutation: SqliteNativeMutation = {
  schemaChange: false,
  mainSchemaChange: false,
  dataChange: false,
  control: undefined,
};

function refusedBeforeReset(error: unknown): boolean {
  // Node checks these native states before ResetStatement; bindings are checked afterward.
  return (
    error instanceof Error &&
    hasErrnoCode(error, "ERR_INVALID_STATE") &&
    [
      "statement has been finalized",
      "database cannot be accessed from an authorizer callback",
      "statement is already being executed",
    ].includes(error.message)
  );
}

/** Dispose callbacks may refuse close; native custody expires only after SQLite has closed. */
export function observeSqliteNativeClose(database: DatabaseSync, onClose: () => void): void {
  for (const method of ["close", Symbol.dispose] as const) {
    if (typeof database[method] !== "function") {
      continue;
    }
    const close = database[method].bind(database);
    database[method] = () => {
      try {
        close();
      } finally {
        if (!database.isOpen) {
          onClose();
        }
      }
    };
  }
}

function callStatement<Result>(
  method: {
    (...parameters: SQLInputValue[]): Result;
    (named: Record<string, SQLInputValue>, ...parameters: SQLInputValue[]): Result;
  },
  [first, ...remaining]: [] | [SQLInputValue | Record<string, SQLInputValue>, ...SQLInputValue[]],
): Result {
  if (first === undefined) {
    return method();
  }
  if (typeof first === "object" && first !== null && !ArrayBuffer.isView(first)) {
    return method(first, ...remaining);
  }
  return method(first, ...remaining);
}

/** Native callbacks can mutate from any SQL, including SELECT and retained prepared statements. */
export function observeSqliteNativeOperations(
  database: DatabaseSync,
  native: NativeSqlite,
  begin: (mutation: SqliteNativeMutation, phase: NativePhase) => NativeOperation,
): <T>(operation: () => T, mutation: SqliteNativeMutation) => T {
  const activeIterators = new Set<IteratorLifetime>();
  const execute = <T>(
    operation: () => T,
    mutation: SqliteNativeMutation,
    phase: NativePhase = "execute",
  ): T => {
    const observed = begin(mutation, phase);
    let succeeded = false;
    try {
      const result = operation();
      if (phase !== "bind") {
        observed.stepped?.();
      }
      succeeded = true;
      return result;
    } finally {
      observed.finish(succeeded);
    }
  };
  database.exec = (sql) =>
    execute(
      () => native.DatabaseSync.prototype.exec.call(database, sql),
      classifySqliteMutation(sql, "batch"),
    );
  database.prepare = (...prepareArgs) => {
    const statement = native.DatabaseSync.prototype.prepare.call(database, ...prepareArgs);
    const mutation = classifySqliteMutation(prepareArgs[0], "statement");
    const run = Object.hasOwn(statement, "run") ? statement.run.bind(statement) : undefined;
    const get = Object.hasOwn(statement, "get") ? statement.get.bind(statement) : undefined;
    const all = Object.hasOwn(statement, "all") ? statement.all.bind(statement) : undefined;
    const iterate = Object.hasOwn(statement, "iterate")
      ? statement.iterate.bind(statement)
      : undefined;
    const active = new Set<IteratorLifetime>();
    let registered = false;
    const reset = <T>(operation: () => T, kind: "reuse" | "finalize" | "return" = "reuse"): T => {
      if (active.size === 0) {
        return operation();
      }
      const previous = [...active];
      for (const lifetime of previous) {
        lifetime.expire();
      }
      let result: T;
      try {
        result = operation();
      } catch (error) {
        if (kind === "reuse" && !refusedBeforeReset(error)) {
          for (const lifetime of previous) {
            try {
              lifetime.invalidate();
            } catch {
              /* Preserve the native binding or execution error. */
            }
          }
        }
        throw error;
      }
      for (const lifetime of previous) {
        if (kind === "return") {
          lifetime.pause();
        } else {
          lifetime.invalidate();
        }
      }
      return result;
    };
    statement.run = (...bindings) =>
      execute(
        () =>
          reset(() =>
            callStatement(run ?? native.StatementSync.prototype.run.bind(statement), bindings),
          ),
        mutation,
      );
    statement.get = (...bindings) =>
      execute(
        () =>
          reset(() =>
            callStatement(get ?? native.StatementSync.prototype.get.bind(statement), bindings),
          ),
        mutation,
      );
    statement.all = (...bindings) =>
      execute(
        () =>
          reset(() =>
            callStatement(all ?? native.StatementSync.prototype.all.bind(statement), bindings),
          ),
        mutation,
      );
    statement.iterate = (...bindings) => {
      if (!registered) {
        // Iterator collection alone does not reset a still-reachable native statement.
        iteratorFinalizer.register(statement, active);
        registered = true;
      }
      // Native iterate resets and binds immediately, but does not step until next().
      const rows = execute(
        () =>
          reset(() =>
            callStatement(
              iterate ?? native.StatementSync.prototype.iterate.bind(statement),
              bindings,
            ),
          ),
        bindingMutation,
        "bind",
      );
      const reference = new WeakRef(rows);
      let done = false;
      const lifetime = createIteratorLifetime(active, activeIterators);
      // oxlint-disable-next-line typescript/unbound-method -- Wrappers pass the native receiver unchanged.
      const nativeNext = rows.next;
      // oxlint-disable-next-line typescript/unbound-method -- Wrappers pass the native receiver unchanged.
      const nativeReturn = rows.return;
      rows.next = function (this: typeof rows, ...args) {
        if (this !== reference.deref() || lifetime.invalidated || done || !database.isOpen) {
          return nativeNext.apply(this, args);
        }
        if (lifetime.finished) {
          lifetime.finished = false;
          active.add(lifetime);
        }
        const alreadyObserved = lifetime.observed !== undefined;
        lifetime.observed ??= begin(mutation, "iterate");
        activeIterators.add(lifetime);
        try {
          const result = nativeNext.apply(this, args);
          if (result.done) {
            done = native.iteratorBehavior.nextAfterDoneIsTerminal;
            if (done) {
              lifetime.finish(true);
            } else {
              lifetime.stopObservation(true);
            }
          } else {
            lifetime.observed.stepped?.();
          }
          return result;
        } catch (error) {
          if (refusedBeforeReset(error)) {
            if (!alreadyObserved) {
              lifetime.pause();
            }
          } else {
            try {
              if (nativeReturn) {
                done = reset(() => nativeReturn.call(this), "return").done === true;
              }
            } catch {
              /* Preserve the native step failure. */
            }
            lifetime.finish();
          }
          throw error;
        }
      };
      if (nativeReturn) {
        rows.return = function (this: typeof rows, ...args) {
          if (
            this !== reference.deref() ||
            (done && native.iteratorBehavior.returnAfterDoneIsInert) ||
            !database.isOpen
          ) {
            return nativeReturn.apply(this, args);
          }
          const result = execute(
            () => reset(() => nativeReturn.apply(this, args), "return"),
            bindingMutation,
            "bind",
          );
          done = result.done === true;
          lifetime.finish();
          return result;
        };
      }
      return rows;
    };
    for (const method of ["close", Symbol.dispose] as const) {
      const close = statement[method]?.bind(statement);
      if (close) {
        statement[method] = () => reset(close, "finalize");
      }
    }
    return statement;
  };
  observeSqliteNativeClose(database, () => {
    for (const lifetime of activeIterators) {
      lifetime.invalidate();
    }
  });
  return execute;
}
