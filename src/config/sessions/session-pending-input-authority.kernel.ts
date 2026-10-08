import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { attachSessionEntrySnapshots } from "./session-entry-snapshots.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type { InternalSessionEntry } from "./types.js";

export function readSessionPendingInputAuthorityFacts(
  database: Pick<OpenClawAgentDatabase, "db" | "path" | "agentId">,
  sessionKey: string,
  agentId = database.agentId,
): SessionPendingInputAuthorityFacts {
  return runSqliteDeferredTransactionSync(database.db, () =>
    readSessionPendingInputAuthorityFactsInTransaction(database, sessionKey, agentId),
  );
}

/** The caller already owns the coherent SQLite transaction. */
export function readSessionPendingInputAuthorityFactsInTransaction(
  database: Pick<OpenClawAgentDatabase, "db" | "path" | "agentId">,
  sessionKey: string,
  agentId = database.agentId,
  /** Exact entries (including absence) read while this same transaction holds its lock. */
  entries?: ReadonlyMap<string, InternalSessionEntry | undefined>,
): SessionPendingInputAuthorityFacts {
  const identity = readOpenClawAgentDatabaseIdentity(database);
  const entry = entries?.has(sessionKey)
    ? entries.get(sessionKey)
    : readSessionEntryRow(database, sessionKey, "list")?.entry;
  return {
    agentId,
    storePath: database.path,
    // Authority uses the logical agent key; SQLite keeps the original stored key.
    sessionKey: toAgentStoreSessionKey({ agentId, requestKey: sessionKey }),
    entry: entry ? attachSessionEntrySnapshots({ ...entry }, {}, "list") : undefined,
    readSource:
      typeof identity.identity === "string"
        ? {
            agentId: database.agentId,
            path: database.path,
            databaseIdentity: identity.identity,
            databaseBirthtime: identity.birthtime,
          }
        : undefined,
    members: listSessionMembersInDatabase(database, sessionKey),
  };
}
