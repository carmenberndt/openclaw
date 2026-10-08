import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { UpdateRunLedgerOptions as LedgerOptions } from "./update-run-codec.js";
import { readUpdateRunRecord as readRun } from "./update-run-read.kernel.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { readUpdateRecovery } from "./update-run-recovery-store.js";
import { updateRunLedgerSchema as schema } from "./update-run-write.js";

/** Retain a completed outcome while its updater still owns the existing state.
 * Publication consumes this fact after release; it never grants recovery authority. */
export function captureCompletedUpdateRun(
  runId: string,
  assertCurrent: () => void,
  options: LedgerOptions,
): UpdateRunRecord | undefined {
  assertCurrent();
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      // This run's retained recovery keeps its existing finalizer. Unrelated
      // historical receipts cannot revoke its completed, owner-held outcome.
      if (readUpdateRecovery(db, runId)) {
        return undefined;
      }
      const record = readRun(db, runId);
      assertCurrent();
      return record?.status === "succeeded" && record.phase === "finished" ? record : undefined;
    },
    options,
    { schemaSql: schema, operationLabel: "update.run" },
  );
}
