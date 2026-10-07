import { isDeepStrictEqual } from "node:util";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerTransferOwner } from "../../infra/sqlite-worker-transfer.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { captureTrajectoryRuntimeRetentionEntryPatch } from "../../trajectory/runtime-retention.sqlite.js";
import { selectConversationRowsFromDatabase } from "./session-accessor.sqlite-conversation-read.js";
import { applySessionEntryPatchInDatabase } from "./session-accessor.sqlite-entry-mutation.js";
import {
  readLifecycleTargetSnapshot,
  readSessionEntrySelectionSnapshot,
  readExactSessionEntryRowValidated,
} from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { sessionEntryPatchPredicateMatches } from "./session-entry-patch-guard.js";
import type {
  SessionEntryPatchCommit,
  SessionEntryPatchCommitted,
  SessionEntryPatchReceipt,
  SessionEntryPatchSelection,
} from "./session-entry-patch.types.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type { SessionSourceValidation } from "./session-source-authority.js";

export function readSessionEntryPatchSnapshot(
  database: OpenClawAgentDatabase,
  selection: SessionEntryPatchSelection,
) {
  return selection.kind === "target"
    ? readLifecycleTargetSnapshot(database, selection.target)
    : readSessionEntrySelectionSnapshot(database, selection.sessionKey, selection.exact);
}

export function commitSessionEntryPatch(
  input: SessionEntryPatchCommit,
  { writeTransaction, admit }: AgentWorkerOperationContext,
): SessionEntryPatchReceipt {
  return writeTransaction(input.operationLabel, "Session patch", (database) => {
    let result: SessionEntryPatchCommitted;
    if (!sessionEntryPatchPredicateMatches(database, input.sessionKey, input.shouldCommitIf)) {
      // A false predicate precedes CAS and the throwing guard, including for a null patch.
      result = { kind: "session-entry-patch", entry: null };
    } else {
      const publishRetention = input.next
        ? captureTrajectoryRuntimeRetentionEntryPatch(database.db)
        : undefined;
      const mutation = applySessionEntryPatchInDatabase(database, {
        ...input,
        readSnapshot: (current) => readSessionEntryPatchSnapshot(current, input.selection),
        options: {
          consumePendingReset: input.consumePendingReset,
          providerReviewMutation: input.providerReviewMutation,
          workerGuard: { cliHistory: input.cliHistory },
          assertCommitAllowed: () => {
            const validation = readSessionSourceValidation(database, input.sources);
            const { refusedSource } = validation;
            if (refusedSource) {
              result = { kind: "session-entry-patch", entry: null, refusedSource };
              transferSessionEntryWorkerCandidate(database, admit, result);
              throw new Error("Session source refusal was not rejected");
            }
            admit("transaction", {
              kind: "session-entry-patch-validated",
              sourceValidation: validation,
            });
          },
        },
      });
      const publication = mutation.identity
        ? prepareSessionEntryReplacementPublication(
            {
              ...mutation.identity,
              pendingArchiveRecovery: false,
              membershipInvalidatedKeys: [],
              maintenancePlans: [],
            },
            database,
          )
        : undefined;
      publishRetention?.();
      result = { kind: "session-entry-patch", entry: mutation.entry, publication };
    }
    return transferSessionEntryWorkerCandidate(database, admit, result);
  });
}

export function readSessionSourceValidation(
  database: OpenClawAgentDatabase,
  sources: SessionEntryPatchCommit["sources"],
  identity = readOpenClawAgentDatabaseIdentity(database).identity,
): SessionSourceValidation {
  const validation: SessionSourceValidation = { conversationMatches: [] };
  for (const [index, source] of (sources ?? []).entries()) {
    if (identity !== source.source.databaseIdentity) {
      return { ...validation, refusedSource: { index, facts: { entry: undefined } } };
    }
    const entry = readExactSessionEntryRowValidated(database, source.sessionKey)?.entry;
    const members =
      source.members === undefined
        ? undefined
        : listSessionMembersInDatabase(database, source.sessionKey).map(
            (member) => member.identityId,
          );
    const alternatives = source.conversationAlternatives;
    let matching: number[] | undefined;
    if (alternatives) {
      const refs = [
        ...new Set(
          alternatives.flatMap((alternative) =>
            alternative.map(({ conversationRef }) => conversationRef),
          ),
        ),
      ];
      const rows = refs.length
        ? selectConversationRowsFromDatabase(database, {
            conversationRefs: refs,
            currentBindingOnly: true,
          })
        : [];
      const selected = new Map(
        rows.map((row) => [
          row.conversationRef,
          row.sessionKey && row.sessionId ? row.sessionKey : null,
        ]),
      );
      matching = alternatives.flatMap((alternative, alternativeIndex) =>
        alternative.every(
          (predicate) => (selected.get(predicate.conversationRef) ?? null) === predicate.sessionKey,
        )
          ? [alternativeIndex]
          : [],
      );
    }
    if (
      Boolean(entry) !== Boolean(source.expected) ||
      source.fields.some((field) => !isDeepStrictEqual(entry?.[field], source.expected?.[field])) ||
      matching?.length === 0 ||
      (members !== undefined && !isDeepStrictEqual(members, source.members)) ||
      (source.transcript &&
        !isDeepStrictEqual(
          { ...readTranscriptContextVersionInTransaction(database, source.transcript.sessionId) },
          source.transcript.version,
        ))
    ) {
      return { ...validation, refusedSource: { index, facts: { entry, members } } };
    }
    if (matching) {
      validation.conversationMatches.push({ index, alternatives: matching });
    }
  }
  return validation;
}

export function transferSessionEntryWorkerCandidate(
  database: OpenClawAgentDatabase,
  admit: AgentWorkerOperationContext["admit"],
  result: { kind: string },
): SessionEntryPatchReceipt;
export function transferSessionEntryWorkerCandidate<Receipt>(
  database: OpenClawAgentDatabase,
  admit: AgentWorkerOperationContext["admit"],
  result: { kind: string },
  wrapReceipt: (receipt: SessionEntryPatchReceipt) => Receipt,
): Receipt;
export function transferSessionEntryWorkerCandidate<Receipt>(
  database: OpenClawAgentDatabase,
  admit: AgentWorkerOperationContext["admit"],
  result: { kind: string },
  wrapReceipt?: (receipt: SessionEntryPatchReceipt) => Receipt,
): SessionEntryPatchReceipt | Receipt {
  // Deliver the exact candidate before COMMIT; the small native receipt certifies it afterward.
  const transfer = createSqliteWorkerTransferOwner();
  const handle = transfer.start([{ kind: "patch", value: result }].values(), {
    kinds: ["patch"],
  });
  try {
    admit("transaction", { kind: "session-entry-patch-transfer", handle });
    for (;;) {
      const frame = transfer.next(handle.id);
      admit("transaction", { kind: "session-entry-patch-frame", frame });
      if (frame.done) {
        break;
      }
    }
    const receipt: SessionEntryPatchReceipt = {
      kind: "session-entry-patch-committed",
      transferId: handle.id,
    };
    const publication = wrapReceipt ? wrapReceipt(receipt) : receipt;
    deferSqliteWorkerCommitReceipt(database.db, publication);
    admit("commit", publication);
    return publication;
  } finally {
    transfer.cancel();
  }
}
