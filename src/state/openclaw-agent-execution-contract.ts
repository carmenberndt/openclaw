import type { IncognitoSessionOperations } from "../config/sessions/session-incognito-contract.js";
import type {
  SqliteWalPeriodicRequest,
  SqliteWalPeriodicResult,
} from "../infra/sqlite-wal-write-admission.js";
import type {
  SqliteWorkerEphemeralTarget,
  SqliteWorkerStore,
} from "../infra/sqlite-worker-contract.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { AgentCreationClaimWitness } from "./agent-creation-claim.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import type {
  AgentDatabaseGenerationClaim,
  AgentDatabaseRequestExecutionSource,
  OpenClawAgentDatabaseAdmissionExecution,
} from "./openclaw-agent-execution-admission-contract.js";
import type { AgentDatabaseDomainOperations } from "./openclaw-agent-execution-domain.js";
import type { RegisteredAgentWorkerOperations } from "./openclaw-agent-execution-operations.js";

/** Recorded by the native owner; a descriptor never grants access to that owner. */
export type AgentDatabaseFileExecutionIdentity = {
  kind: "file";
  physicalIdentity: string;
  birthtime?: string;
  incarnation: string;
  nativeLocation: string;
};

export type AgentDatabaseExecutionFileIdentity = Pick<
  AgentDatabaseFileExecutionIdentity,
  "kind" | "physicalIdentity" | "birthtime" | "nativeLocation"
>;

export type AgentDatabaseExecutionScope = Pick<
  SqliteWorkerStore<AgentDatabaseOperations>,
  "execute"
>;

export type OpenClawAgentDatabaseExecution = OpenClawAgentDatabaseAdmissionExecution & {
  /** The accepted native receipt; reading this never adopts the current pathname. */
  readonly fileIdentity: AgentDatabaseExecutionFileIdentity | undefined;
  /** Accept the admitted native handle used by a synchronous SDK operation. */
  adoptNativeDatabase(database: OpenClawAgentDatabase): Promise<void>;
  /** Reuse only a native generation whose preparation and registration publication settled. */
  capturePreparedGenerationClaim(): AgentDatabaseGenerationClaim | undefined;
  /** Admit a write against existing storage; a missing store remains missing. */
  runExisting<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    options?: { retireNativeOnFailure: true },
  ): Promise<T | undefined>;
  /**
   * Join this reference's work; native cleanup failures remain with its resource owner.
   * The owner may retain one bounded idle generation.
   */
  release(): Promise<void>;
};

export type AgentDatabaseFileExecutionOwner = {
  readonly kind: "file";
  readonly agentId: string;
  readonly sharedDatabaseKey: string;
  readonly creationIdentity?: DatabasePathIdentity;
  borrow(
    pathname: string,
    expectedIdentity?: AgentDatabaseExecutionFileIdentity,
    expectedCreationIdentity?: DatabasePathIdentity,
    requestedPath?: string,
  ): OpenClawAgentDatabaseExecution;
  closeIdle(): Promise<void>;
  close(): Promise<void>;
};

export type AgentDatabaseNativeGeneration = {
  failure(): "open-refused" | "native" | undefined;
  isPrepared(): boolean;
  captureClaim(): AgentDatabaseGenerationClaim;
  run<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent?: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    createIfMissing?: boolean,
    signal?: AbortSignal,
    readmitSchema?: boolean,
  ): Promise<T | undefined>;
  close(): Promise<void>;
};

export type AgentDatabaseFileExecutionOpen = {
  kind?: "file";
  leaseId: string;
  agentId: string;
  databasePath: string;
  stateDatabasePath: string;
  environment: SqliteWorkerStateContext["environment"];
  expectedIdentity?: AgentDatabaseExecutionFileIdentity;
  /** Captured before a creating request yields; absence is an identity too. */
  creatingIdentity?: DatabasePathIdentity;
  creationClaim?: AgentCreationClaimWitness;
};

/** Process-private locators; neither a handle nor its incarnation grants authority. */
export type AgentDatabaseIncognitoIdentity = Readonly<SqliteWorkerEphemeralTarget>;

export type AgentDatabaseIncognitoOpen = {
  kind: "ephemeral";
  identity: AgentDatabaseIncognitoIdentity;
  agentId: string;
  databasePath: string;
  environment: SqliteWorkerStateContext["environment"];
};

export type AgentDatabaseExecutionOpen =
  | AgentDatabaseFileExecutionOpen
  | AgentDatabaseIncognitoOpen;

type AgentDatabaseIncognitoMemory = {
  agentId: string;
  /** SQLite page allocation only, excluding allocator, decoded results, and transport memory. */
  databaseBytes: number;
  pageCount: number;
  pageSize: number;
};

/** Inactive actor operations; production routing changes only at the complete cutover. */
export type AgentDatabaseIncognitoOperations = IncognitoSessionOperations & {
  "database.incognito.memory": { input: undefined; output: AgentDatabaseIncognitoMemory };
};

export type AgentDatabaseIncognitoAuthority = { assertCurrent(): void };

export type AgentDatabaseOperations = AgentDatabaseDomainOperations &
  RegisteredAgentWorkerOperations & {
    "database.walMaintenance": { input: SqliteWalPeriodicRequest; output: SqliteWalPeriodicResult };
    "database.prepareWrite": { input: undefined; output: void };
    "database.recordIntegrity": { input: undefined; output: boolean };
  };
