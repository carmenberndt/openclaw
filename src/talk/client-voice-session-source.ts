import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
} from "../config/sessions/session-source-authority.js";
import { resolveStateDir } from "../config/state-dir.js";
import {
  assertDatabasePathIdentity,
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  assertClientVoiceSessionSettlementCurrent,
  captureClientVoiceSessionSettlementContext,
} from "./client-voice-session-lifecycle.js";

/** Voice metadata stays bound to its admitted physical store across provider and queue waits. */
export function captureClientVoiceSessionSourceOptions(agentId: string) {
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const path = resolveOpenClawAgentSqlitePath({ agentId, env });
  return { agentId, env, path };
}

export function createClientVoiceSessionSource(
  options: ReturnType<typeof captureClientVoiceSessionSourceOptions>,
  identity: DatabasePathIdentity,
) {
  const settlementContext = captureClientVoiceSessionSettlementContext(options.env);
  return {
    options,
    identity,
    settlementContext,
    assertCurrent() {
      assertClientVoiceSessionSettlementCurrent(settlementContext);
      settlementContext.admission.assertCurrent();
      assertDatabasePathIdentity(options.path, identity);
    },
  };
}

export function captureClientVoiceSessionSource(agentId: string) {
  const options = captureClientVoiceSessionSourceOptions(agentId);
  return createClientVoiceSessionSource(options, readDatabasePathIdentitySync(options.path));
}

export type ClientVoiceSessionSource = ReturnType<typeof captureClientVoiceSessionSource>;

/** Foreign source checks retain their own readers; local predicates belong to the voice writer. */
export async function prepareClientVoiceSessionSourceChecks(
  writer: Pick<ClientVoiceSessionSource, "options" | "identity">,
  authorities: readonly PreparedSessionSourceAuthority[],
): Promise<PreparedSessionSourceAuthority> {
  const checks: PreparedSessionSourceAuthority["checks"] = [];
  const foreign = new Map<string | symbol, PreparedSessionSourceAuthority["checks"]>();
  for (const check of authorities.flatMap((authority) => authority.checks)) {
    const source = check.predicate.source;
    if (
      typeof source.databaseIdentity === "string" &&
      `file:${source.databaseIdentity}` === writer.identity.key &&
      source.databaseBirthtime === writer.identity.birthtime
    ) {
      checks.push(check);
    } else {
      const group = foreign.get(source.databaseIdentity) ?? [];
      group.push(check);
      foreign.set(source.databaseIdentity, group);
    }
  }
  const assertAuthoritiesCurrent = () =>
    authorities.forEach((authority) => authority.assertCurrent());
  if (foreign.size === 0) {
    return { checks, assertCurrent: assertAuthoritiesCurrent };
  }
  const [
    { retainOpenClawAgentDatabaseReadOnly },
    { readOpenClawAgentDatabaseIdentity },
    { readRefusedSessionSource },
    { hasSqliteSessionOwnerColumns },
    { runSqliteReadOperationSync },
  ] = await Promise.all([
    import("../state/openclaw-agent-db-readonly.js"),
    import("../state/openclaw-agent-db-identity.js"),
    import("../config/sessions/session-source-predicate.worker.js"),
    import("../config/sessions/session-accessor.sqlite-owner-projection.js"),
    import("../infra/sqlite-schema-facts.js"),
  ]);
  const resources: Pick<PreparedSessionSourceAuthority, "release">[] = [];
  const release = () => releaseSessionSourceAuthorities(resources);
  const assertions: (() => void)[] = [];
  try {
    assertAuthoritiesCurrent();
    for (const group of foreign.values()) {
      const source = group[0]!.predicate.source;
      const assertPathsCurrent = () => {
        for (const { predicate } of group) {
          if (typeof predicate.source.databaseIdentity === "string") {
            assertExistingDatabaseIdentity(
              predicate.source.path,
              `file:${predicate.source.databaseIdentity}`,
              predicate.source.databaseBirthtime,
            );
          }
        }
      };
      assertPathsCurrent();
      const retained = retainOpenClawAgentDatabaseReadOnly({
        ...writer.options,
        agentId: source.agentId,
        path: source.path,
      });
      if (!retained.found) {
        throw new Error("Voice session source is unavailable");
      }
      resources.push(retained.claim);
      const identity = readOpenClawAgentDatabaseIdentity(retained.database);
      if (
        identity.identity !== source.databaseIdentity ||
        identity.birthtime !== source.databaseBirthtime
      ) {
        throw new Error("Voice session source changed its captured database owner");
      }
      // A first native query can discover owner columns; do that before worker grants.
      hasSqliteSessionOwnerColumns(retained.database.db);
      const predicates = group.map((check) => check.predicate);
      assertions.push(() => {
        assertPathsCurrent();
        retained.claim.assertCurrent();
        const refused = runSqliteReadOperationSync(
          retained.database.db,
          () => readRefusedSessionSource(retained.database, predicates),
          "fresh",
        );
        if (refused) {
          group[refused.index]!.refuse(refused.facts);
        }
      });
    }
    return {
      nativeSource: true,
      checks,
      assertCurrent: () => {
        assertAuthoritiesCurrent();
        assertions.forEach((assertCurrent) => assertCurrent());
      },
      release,
    };
  } catch (error) {
    await releaseSessionSourceAuthorities(resources, [error]);
    throw error;
  }
}
