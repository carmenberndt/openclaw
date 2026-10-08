import type { DatabaseSync } from "node:sqlite";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { UPDATE_RECOVERY_KEY_END, UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";
import {
  decodeUpdateRecovery,
  inspectUpdateRecovery,
  type UpdateRecoveryInspection,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";

type RecoveryDatabase = Pick<DB, "update_runs" | "config_machine_state">;

function readRecoveryRows(db: DatabaseSync, runId?: string) {
  if (!tableExists(db, "config_machine_state")) {
    return [];
  }
  const query = getNodeSqliteKysely<RecoveryDatabase>(db)
    .selectFrom("config_machine_state")
    .select(["state_key", "value_json"]);
  return executeSqliteQuerySync(
    db,
    runId !== undefined
      ? query.where("state_key", "=", UPDATE_RECOVERY_KEY_PREFIX + runId)
      : query
          .where("state_key", ">=", UPDATE_RECOVERY_KEY_PREFIX)
          .where("state_key", "<", UPDATE_RECOVERY_KEY_END)
          .orderBy("state_key", "asc"),
  ).rows;
}
/** Select before decoding so unrelated historical damage cannot veto this run. */
export function readUpdateRecovery(
  db: DatabaseSync,
  runId: string,
): UpdateRecoveryRecord | undefined {
  const row = readRecoveryRows(db, runId)[0];
  return row ? decodeUpdateRecovery(row.value_json, runId) : undefined;
}

/** Historical inspection shares the caller's transaction; it never grants execution authority. */
export function inspectUpdateRecoveryRows(
  db: DatabaseSync,
  runId?: string,
): UpdateRecoveryInspection[] {
  return readRecoveryRows(db, runId).map(({ value_json, state_key }) =>
    inspectUpdateRecovery(value_json, state_key.slice(UPDATE_RECOVERY_KEY_PREFIX.length)),
  );
}
/** Private read-only compatibility surface for diagnostics and retained-pair
 * inspection. Legacy receipts remain exact historical evidence, never authority.
 * The execution loader deliberately rejects them instead of upgrading them. */
export function inspectUpdateRecoveries(
  options: OpenClawStateDatabaseOptions = {},
  runId?: string,
): UpdateRecoveryInspection[] {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => inspectUpdateRecoveryRows(db, runId),
      options,
    ) ?? []
  );
}
