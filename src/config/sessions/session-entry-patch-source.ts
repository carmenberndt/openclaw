import { isMainThread } from "node:worker_threads";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import { assertCapturedSessionEntryReadSource } from "./session-accessor.sqlite-exact-read.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SqliteSessionEntrySnapshotPatchParams } from "./session-entry-patch.types.js";
import { captureIncognitoSessionBinding } from "./session-incognito-binding.js";

/** Bind entry preparation and commit checks to the original physical store before yielding. */
export function captureSessionEntryPatchSource(params: SqliteSessionEntrySnapshotPatchParams) {
  const { resolved: scope, sessionKey, capturedSource: captured, options } = params;
  const { retainedExecution } = options;
  // Queueing and either cold open must retain the same registration and lease owner.
  const resolved = {
    ...scope,
    env: cloneEnvWithPlatformSemantics(scope.env ?? process.env),
  };
  resolved.env.OPENCLAW_STATE_DIR = resolveStateDir(resolved.env);
  const databaseOptions = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(databaseOptions);
  const targetIdentity = readDatabasePathIdentitySync(databasePath);
  resolved.path = databasePath;
  databaseOptions.path = databasePath;
  const incognito = isIncognitoOpenClawAgentSqlitePath(databasePath, databaseOptions);
  const incognitoBinding = captureIncognitoSessionBinding({
    agentId: databaseOptions.agentId,
    env: resolved.env,
    sessionKey,
    storePath: databasePath,
  });
  const useWorker =
    !incognitoBinding &&
    isMainThread &&
    options.workerGuard !== undefined &&
    !options.shouldCommit &&
    !options.assertCommitAllowed &&
    supportsOpenClawAgentDatabaseExecution(databaseOptions);
  const ensure = options.workerGuard?.ensureIdentitySource;
  if (
    ensure &&
    (!useWorker ||
      typeof params.update === "function" ||
      params.update.kind !== "ensure-identity" ||
      ensure.agentId !== resolved.agentId)
  ) {
    throw new Error("Transaction-local entry authority requires a closed worker ensure");
  }
  if (
    ensure &&
    (targetIdentity.key !== `file:${String(ensure.source.databaseIdentity)}` ||
      targetIdentity.birthtime !== ensure.source.databaseBirthtime)
  ) {
    throw new Error("Transaction-local entry authority differs from its writer");
  }
  const assertCapturedSource = (database?: OpenClawAgentDatabase) => {
    if (!captured) {
      return;
    }
    if (incognitoBinding) {
      const { actor } = incognitoBinding;
      actor.assertCurrent();
      if (
        captured.agentId !== actor.agentId ||
        captured.path !== actor.path ||
        captured.databaseIdentity !== actor.identity.incarnation ||
        captured.databaseBirthtime !== undefined
      ) {
        throw new Error("Captured session database changed before entry patch");
      }
      return;
    }
    if (!database && typeof captured.databaseIdentity === "string") {
      assertExistingDatabaseIdentity(
        captured.path,
        `file:${captured.databaseIdentity}`,
        captured.databaseBirthtime,
      );
    }
    assertCapturedSessionEntryReadSource(
      captured,
      database ?? getOpenClawAgentDatabaseIfOpen(databaseOptions),
    );
  };
  const assertCurrent = () => {
    if (retainedExecution) {
      retainedExecution.assertCurrent();
      const identity = retainedExecution.fileIdentity;
      if (
        !captured ||
        !identity ||
        retainedExecution.agentId !== databaseOptions.agentId ||
        captured.databaseIdentity !== identity.physicalIdentity ||
        captured.databaseBirthtime !== identity.birthtime
      ) {
        throw new Error("Retained session writer differs from its acknowledged source");
      }
    }
    if (targetIdentity.key.startsWith("file:")) {
      assertExistingDatabaseIdentity(databasePath, targetIdentity.key, targetIdentity.birthtime);
    }
    assertCapturedSource();
  };
  if (retainedExecution) {
    assertCurrent();
  }
  return {
    resolved,
    databaseOptions,
    databasePath,
    targetIdentity,
    incognito,
    incognitoBinding,
    useWorker,
    ensureIdentitySource: ensure
      ? { source: ensure.source, agentId: ensure.agentId, sessionKey: ensure.sessionKey }
      : undefined,
    assertCapturedSource,
    assertCurrent,
  };
}
