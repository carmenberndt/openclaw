import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  decodeUpdateRecovery,
  isUpdateRecoveryPending,
  UpdateRecoveryRequiredError,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import { inspectUpdateRecoveries, readUpdateRecovery } from "./update-run-recovery-store.js";
export type { UpdateRecoveryFence, UpdateRecoveryHandoff } from "./update-run-recovery-types.js";
export { UpdateRecoveryRequiredError } from "./update-run-recovery-schema.js";
export type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
export { inspectUpdateRecoveries } from "./update-run-recovery-store.js";
/** Must run before general database open, admission writes, or runtime migration. */
export function loadUpdateRecovery(
  runId: string,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord | undefined {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readUpdateRecovery(db, runId),
      options,
    ) ?? undefined
  );
}
/** Detection only. This delivery never claims, rewrites, or retires retained recovery. */
export function assertNoPendingUpdateRecovery(options: OpenClawStateDatabaseOptions = {}): void {
  const pending = inspectUpdateRecoveries(options).find(({ record }) =>
    isUpdateRecoveryPending(record),
  );
  if (pending) {
    // Historical terminal evidence can exclude completed work, never authorize
    // execution. Pending legacy evidence still fails the strict recovery decoder.
    throw new UpdateRecoveryRequiredError(decodeUpdateRecovery(pending.raw, pending.record.runId));
  }
}
