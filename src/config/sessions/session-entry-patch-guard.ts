import { isDeepStrictEqual } from "node:util";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { readActivePathEntryRelationFromProjection } from "./session-accessor.sqlite-active-events.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import type {
  SessionEntryPatchCommit,
  SessionEntryPatchCommitted,
  SessionEntryPatchGuard,
} from "./session-entry-patch.types.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";

/** CLI planning yields; admission and the exact tip belong to the writer's transaction. */
export function assertSessionEntryPatchCliHistory(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  context: SessionEntryPatchGuard["cliHistory"],
): void {
  if (!context) {
    return;
  }
  if (context.admission) {
    validateSessionTranscriptContextInDatabase(
      database,
      { agentId: database.agentId, path: database.path, sessionKey, sessionId: context.sessionId },
      { admission: context.admission },
    );
  }
  const fresh = readSessionTranscriptWatermarkInDatabase(database, context.sessionId);
  if (
    fresh.generation !== context.watermark.generation ||
    fresh.maxSeq !== context.watermark.maxSeq
  ) {
    throw new Error("CLI history changed before preparation");
  }
}

export function sessionEntryPatchPredicateMatches(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  predicate: SessionEntryPatchGuard["shouldCommitIf"],
): boolean {
  if (!predicate) {
    return true;
  }
  if (
    readSessionTranscriptWatermarkInDatabase(database, predicate.sessionId).generation !==
    predicate.generation
  ) {
    return false;
  }
  const leafEntryId = predicate.leafEntryId;
  if (!leafEntryId) {
    return true;
  }
  const projection = readCurrentProjectionSnapshot(
    database,
    { agentId: database.agentId, path: database.path, sessionKey, sessionId: predicate.sessionId },
    (snapshot) => readActivePathEntryRelationFromProjection(snapshot, leafEntryId) !== "off-path",
  );
  // A stale predicate retries through its host reader, which owns projection repair.
  return projection.kind === "value" && projection.value;
}

export function readRefusedSessionSource(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  sources: SessionEntryPatchCommit["sources"],
  identity = readOpenClawAgentDatabaseIdentity(database).identity,
): SessionEntryPatchCommitted["refusedSource"] {
  for (const [index, source] of (sources ?? []).entries()) {
    if (identity !== source.source.databaseIdentity) {
      return { index, facts: { entry: undefined } };
    }
    const entry = readExactSessionEntryRowValidated(database, source.sessionKey)?.entry;
    const members =
      source.members === undefined
        ? undefined
        : listSessionMembersInDatabase(database, source.sessionKey).map(
            (member) => member.identityId,
          );
    if (
      Boolean(entry) !== Boolean(source.expected) ||
      source.fields.some((field) => !isDeepStrictEqual(entry?.[field], source.expected?.[field])) ||
      (members !== undefined && !isDeepStrictEqual(members, source.members)) ||
      (source.transcript &&
        !isDeepStrictEqual(
          { ...readTranscriptContextVersionInTransaction(database, source.transcript.sessionId) },
          source.transcript.version,
        ))
    ) {
      return { index, facts: { entry, members } };
    }
  }
  return undefined;
}
