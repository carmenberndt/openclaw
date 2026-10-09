import type { MessagePort } from "node:worker_threads";
import type { SqliteWorkerError } from "./sqlite-worker-contract.js";

export type SqliteWorkerOperationContext = {
  port: MessagePort;
  attachment?: { value: unknown };
  refusal?: SqliteWorkerError;
  committed?: { facts: unknown };
  settled?: true;
};

/** Native settlement is independent of whether delivery of the result succeeded. */
export type SqliteWorkerOperationSettlement =
  | { kind: "completed" }
  | { kind: "not-entered"; error: unknown }
  | { kind: "unknown"; error: unknown; nativeStopped?: true };

/** Private operation receipts describe completed work; they never grant write authority. */
export type SqliteWorkerNativeSettlement =
  | { kind: "completed"; committed?: { facts: unknown } }
  | { kind: "unknown"; committed?: { facts: unknown } };

export type SqliteWorkerNativeSettlementOwner = {
  readonly committed: { facts: unknown } | undefined;
  readonly settlement: SqliteWorkerNativeSettlement | undefined;
  waitForSettlement(
    deadlineMs: number,
  ): Extract<SqliteWorkerNativeSettlement, { kind: "completed" }>;
};

/** The broker resolves this only from the executing owner's settlement evidence. */
export type RetainedWorkerTransactionAdmission = {
  readonly settled: Promise<SqliteWorkerOperationSettlement>;
};

/** The executing worker calls this only after its backend's native settlement check. */
export function settleSqliteWorkerOperationContext(
  owner: SqliteWorkerOperationContext,
  kind: "completed" | "unknown",
): void {
  if (owner.settled) {
    return;
  }
  owner.settled = true;
  owner.port.postMessage(
    {
      kind: "native-settlement",
      settlement: { kind, ...(owner.committed ? { committed: owner.committed } : {}) },
    },
    [],
  );
}
