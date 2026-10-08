import type { SessionGoalOperation } from "./goals-operations.types.js";
import type { SessionTranscriptWriteScope } from "./session-accessor.types.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";
import type { TranscriptAppendRefusal } from "./session-transcript-writer-claim-error.js";
import type {
  SqliteExpectedSessionTranscriptTurnResult,
  SqliteSessionTurnOptions,
} from "./session-turn.types.js";

export type SessionColdMutationResult = {
  archivedTranscripts: number;
  externalizedTranscripts: number;
  restored: boolean;
  sessionKey?: string;
  turnRebound?: SqliteExpectedSessionTranscriptTurnResult;
  refusedSource?: NonNullable<SessionSourceValidation["refusedSource"]>;
  writerRefusal?: TranscriptAppendRefusal;
};

type SessionColdTurnGuard = {
  kind: "turn";
  sources?: SessionSourcePredicate[];
  requireActive?: boolean;
  agentId: string;
  sessionKey: string;
  options: Pick<
    SqliteSessionTurnOptions,
    | "keyFormat"
    | "expectedSessionId"
    | "selectedSessionId"
    | "selectedLifecycleRevision"
    | "expectedLifecycleRevision"
    | "expectedWriterRunId"
    | "expectedSessionState"
    | "initialSessionEntry"
  >;
  goalOperation?: SessionGoalOperation;
};

export type SessionColdLockedGuard = {
  kind: "locked";
  agentId: string;
  sessionKey: string;
  sources: SessionSourcePredicate[];
  fence: Pick<
    SessionTranscriptWriteScope,
    "expectedOwner" | "expectedLifecycleRevision" | "expectedWriterRunId"
  >;
};

export type SessionColdRestorationGuard = SessionColdTurnGuard | SessionColdLockedGuard;
