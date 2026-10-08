import { readExactSessionEntryRowValidated } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { listSessionMembersInDatabase } from "../config/sessions/session-sharing-store.kernel.js";
import {
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourcePredicateFacts,
} from "../config/sessions/session-source-authority.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
  isSessionStoreReadCandidateCurrent,
} from "../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import { retainSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  assertIncognitoAgentDatabasePathAvailable,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  createSessionSharingLookupCaches,
  sessionMutationTargetChanged,
  type AuthorizedSessionMutationTarget,
  type SessionSharingLookupCaches,
  type SessionMutationAuthorizationParams,
} from "./session-sharing-authorization.js";
import {
  authorizeOwnSessionMutation,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import type {
  SessionMutationTarget,
  resolveTalkSessionTargetInput,
} from "./session-sharing-target-input.js";
import { prepareTalkSessionTarget, assertTalkSessionStorageTarget } from "./talk/session-target.js";
import type { PreparedTalkSessionTarget } from "./talk/session-target.types.js";

/** Capture the complete selector family before resolving its physical owner. */
function captureSessionSharingStore(
  target: Pick<SessionSharingTarget, "agentId" | "storePath" | "readSource">,
  env: NodeJS.ProcessEnv,
  assertCallerCurrent: () => void,
) {
  const candidates = captureSessionStoreReadCandidates(target.storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const { agentId, storePath, readSource } = target;
  return async () => {
    assertCallerCurrent();
    const resolved =
      readSource ?? (await prepareSqliteTargetFromSessionStorePath(storePath, { agentId, env }));
    const assertSourcePathCurrent = () => {
      if (!candidates.every(isSessionStoreReadCandidateCurrent)) {
        throw new Error("Session sharing source changed");
      }
      try {
        return assertSessionStoreReadCandidate(resolved.path, candidates);
      } catch (cause) {
        throw new Error("Session sharing source changed", { cause });
      }
    };
    const pathname = assertSourcePathCurrent();
    const identity = identities.get(pathname);
    if (!resolved.agentId || !identity?.key.startsWith("file:")) {
      throw new Error("Session sharing source is unavailable");
    }
    const source: CapturedSessionEntryReadSource = readSource ?? {
      agentId: resolved.agentId,
      path: pathname,
      databaseIdentity: identity.key.slice("file:".length),
      databaseBirthtime: identity.birthtime,
    };
    const databaseIdentity = source.databaseIdentity;
    if (typeof databaseIdentity !== "string") {
      throw new Error("Session sharing reader requires a file-backed source");
    }
    const assertCurrent = () => {
      assertSourcePathCurrent();
      assertExistingDatabaseIdentity(pathname, identity.key, identity.birthtime);
      assertExistingDatabaseIdentity(
        source.path,
        `file:${databaseIdentity}`,
        source.databaseBirthtime,
      );
    };
    assertCallerCurrent();
    assertCurrent();
    return { source, assertCurrent };
  };
}

/** Hold the existing reader only until the prepared writer operation settles. */
export async function prepareSessionSharingSource(
  target: Pick<
    SessionSharingTarget,
    "agentId" | "canonicalKey" | "storeKey" | "storePath" | "readSource"
  >,
  assertCallerCurrent: () => void,
) {
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const prepareSource = captureSessionSharingStore(target, env, assertCallerCurrent);
  const { source, assertCurrent: assertSourceCurrent } = await prepareSource();
  const retained = retainSessionHistoryWorkerDatabase({
    agentId: source.agentId,
    path: source.path,
    env,
  });
  const assertCurrent = () => {
    assertCallerCurrent();
    assertSourceCurrent();
    retained.owner.assertCurrent();
  };
  try {
    const result = await retained.owner.readExactEntries({
      sessionKeys: [target.storeKey],
      projection: "sharing",
      includeAuthorization: true,
      env,
    });
    assertCurrent();
    if (
      result.databaseIdentity?.identity !== source.databaseIdentity ||
      result.databaseIdentity?.birthtime !== source.databaseBirthtime
    ) {
      throw new Error("Session sharing source changed");
    }
    const entry = result.entries.find(({ sessionKey }) => sessionKey === target.storeKey)?.entry;
    return {
      source,
      target: entry ? { ...target, readSource: source, storeKeys: [target.storeKey], entry } : null,
      members:
        result.sharing?.members.find((row) => row.sessionKey === target.storeKey)?.identityIds ??
        [],
      assertCurrent,
      release: retained.release,
    };
  } catch (error) {
    await releaseSessionSourceAuthorities([retained], [error]);
    throw error;
  }
}

/** Storage facts are prepared here; the sharing owner supplies every access decision. */
export function withPreparedSessionSharingSource(params: {
  targets: AuthorizedSessionMutationTarget[];
  sourceConfig: OpenClawConfig;
  request: SessionMutationAuthorizationParams;
  ownSessionProfileId?: string;
  talk: ReturnType<typeof resolveTalkSessionTargetInput>;
  assertTalkTargetCurrent: (cfg: OpenClawConfig) => void;
  assertTargetCurrent: (
    target: SessionMutationTarget,
    expected: AuthorizedSessionMutationTarget | undefined,
    cfg: OpenClawConfig,
    caches?: SessionSharingLookupCaches,
    ensuredSessionId?: string,
    prepared?: { target: SessionSharingTarget | null; members: readonly string[] },
  ) => void;
}): SessionSourceAssertion {
  const targetChanged = (key: string) => sessionMutationTargetChanged(params.request.method, key);
  const assertSource = () => {
    const error = authorizeOwnSessionMutation({
      client: params.request.client,
      target: null,
      expectedProfileId: params.ownSessionProfileId,
    });
    if (error) {
      throw new SessionMutationAuthorizationChangedError(error);
    }
    return params.request.context.getRuntimeConfig();
  };
  const assertCurrent = () => {
    const cfg = assertSource();
    params.assertTalkTargetCurrent(cfg);
    const caches = createSessionSharingLookupCaches();
    for (const target of params.targets) {
      params.assertTargetCurrent(target, target, cfg, caches);
    }
  };
  const changed = () => targetChanged(params.targets[0]?.sessionKey ?? "");
  const assertRoutingCurrent = captureSessionMutationRouting(params.sourceConfig, changed);
  const talkAgentId = params.sourceConfig.talk?.agentId;
  const assertSourceCurrent = () => {
    const cfg = assertSource();
    assertRoutingCurrent(cfg);
    if (
      (params.talk && cfg.talk?.agentId !== talkAgentId) ||
      (params.talk?.kind === "relay" && !params.talk.isCurrent())
    ) {
      throw changed();
    }
  };
  // Incognito source rows remain native, but grants must never re-open their owners.
  if (params.targets.some((target) => isIncognitoSessionKey(target.sessionKey))) {
    const env = captureSessionTranscriptStorageEnvironment(process.env);
    return Object.assign(assertCurrent, {
      nativeSource: true,
      prepareSessionSource: () =>
        prepareNativeSessionSharingSource(params, env, assertSourceCurrent),
    });
  }
  return Object.assign(assertCurrent, {
    async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
      const prepared: Awaited<ReturnType<typeof prepareSessionSharingSource>>[] = [];
      const release = () => releaseSessionSourceAuthorities(prepared);
      try {
        assertSourceCurrent();
        const targets = params.targets.map((expected) => {
          const route = expected.resolved ?? expected.absentTarget;
          if (!route) {
            throw targetChanged(expected.sessionKey);
          }
          return { ...route, storeKey: expected.resolved?.storeKey ?? route.canonicalKey };
        });
        for (const target of targets) {
          prepared.push(await prepareSessionSharingSource(target, assertSourceCurrent));
        }
        const assertPrepared = (index: number, facts?: SessionSourcePredicateFacts) => {
          const read = prepared[index]!;
          if (!facts) {
            read.assertCurrent();
          }
          assertSourceCurrent();
          const expected = params.targets[index]!;
          params.assertTargetCurrent(expected, expected, assertSource(), undefined, undefined, {
            target: facts
              ? facts.entry
                ? {
                    ...targets[index]!,
                    storeKeys: [targets[index]!.storeKey],
                    readSource: read.source,
                    entry: facts.entry,
                  }
                : null
              : read.target,
            members: facts?.members ?? read.members,
          });
        };
        const assertPreparedCurrent = () => {
          assertSourceCurrent();
          for (let index = 0; index < prepared.length; index += 1) {
            assertPrepared(index);
          }
        };
        assertPreparedCurrent();
        return {
          assertCurrent: assertPreparedCurrent,
          checks: prepared.map((read, index) => ({
            predicate: {
              source: read.source,
              sessionKey: targets[index]!.storeKey,
              fields: [
                "sessionId",
                "lifecycleRevision",
                "createdActor",
                "visibility",
                "incognito",
                "sandbox",
              ],
              expected: read.target?.entry,
              members: read.members,
            },
            refuse: (facts) => {
              assertPrepared(index, facts);
              throw targetChanged(params.targets[index]!.sessionKey);
            },
          })),
          release,
        };
      } catch (error) {
        await releaseSessionSourceAuthorities(prepared, [error]);
        throw error;
      }
    },
  });
}

async function prepareNativeSessionSharingSource(
  params: Parameters<typeof withPreparedSessionSharingSource>[0],
  env: NodeJS.ProcessEnv,
  assertSourceCurrent: () => void,
): Promise<PreparedSessionSourceAuthority> {
  const resources: Pick<PreparedSessionSourceAuthority, "release">[] = [];
  const release = () => releaseSessionSourceAuthorities(resources);
  try {
    assertSourceCurrent();
    const sharedContext = captureOpenClawStateReadWorkerContext({ env });
    const retainSource = (agentId: string, path: string) => {
      const retained = retainOpenClawAgentDatabaseReadOnly({ agentId, path, env });
      if (!retained.found) {
        throw new Error("Session sharing source is unavailable");
      }
      resources.push(retained.claim);
      return retained;
    };
    const selections = params.targets.map((expected) => {
      const target = expected.resolved ?? expected.absentTarget;
      if (!target) {
        throw sessionMutationTargetChanged(params.request.method, expected.sessionKey);
      }
      if (isIncognitoSessionKey(expected.sessionKey)) {
        // Pin every process-held source before durable owner discovery can yield.
        const pathname = resolveIncognitoOpenClawAgentSqlitePath({ agentId: target.agentId, env });
        return {
          expected,
          target,
          incognito: true as const,
          retained: retainSource(target.agentId, pathname),
        };
      }
      return {
        expected,
        target,
        incognito: false as const,
        prepareSource: captureSessionSharingStore(target, env, assertSourceCurrent),
      };
    });
    const reads: Array<
      Pick<(typeof selections)[number], "expected" | "target" | "incognito"> & {
        retained: ReturnType<typeof retainSource>;
        readSource: CapturedSessionEntryReadSource;
        assertSourceCurrent: (() => void) | undefined;
        key: string;
      }
    > = [];
    for (const selection of selections) {
      const { expected, target, incognito } = selection;
      const native = selection.incognito
        ? { retained: selection.retained, assertCurrent: undefined }
        : await selection.prepareSource().then((prepared) => ({
            retained: retainSource(prepared.source.agentId, prepared.source.path),
            assertCurrent: prepared.assertCurrent,
          }));
      const retained = native.retained;
      const identity = readOpenClawAgentDatabaseIdentity(retained.database);
      const readSource = {
        agentId: retained.database.agentId,
        path: retained.database.path,
        databaseIdentity: identity.identity,
        databaseBirthtime: identity.birthtime,
      };
      reads.push({
        expected,
        target,
        incognito,
        retained,
        readSource,
        assertSourceCurrent: native.assertCurrent,
        key: expected.resolved?.storeKey ?? target.canonicalKey,
      });
    }
    const [{ prepareOpenClawStateCurrentReader }, { readAgentDeletionJournalInDatabase }] =
      await Promise.all([
        import("../state/openclaw-state-db-current-reader.js"),
        import("../state/agent-deletion-journal.js"),
      ]);
    const shared = await prepareOpenClawStateCurrentReader(sharedContext);
    if (!shared) {
      throw new Error("Session sharing source has no admitted shared state");
    }
    resources.push({ release: () => shared.dispose() });
    const assertCurrent = () => {
      assertSourceCurrent();
      for (const read of reads) {
        read.assertSourceCurrent?.();
        read.retained.claim.assertCurrent();
        if (read.incognito) {
          assertIncognitoAgentDatabasePathAvailable(read.readSource.path);
        } else {
          assertExistingDatabaseIdentity(
            read.readSource.path,
            `file:${String(read.readSource.databaseIdentity)}`,
            read.readSource.databaseBirthtime,
          );
        }
        if (
          shared.read((database) =>
            readAgentDeletionJournalInDatabase(database, read.target.agentId, "runtime"),
          )
        ) {
          throw new Error(
            `OpenClaw agent database is unavailable while agent ${read.target.agentId} is deleted.`,
          );
        }
        const entry = readExactSessionEntryRowValidated(
          read.retained.database,
          read.key,
          "list",
        )?.entry;
        params.assertTargetCurrent(
          read.expected,
          read.expected,
          params.request.context.getRuntimeConfig(),
          undefined,
          undefined,
          {
            target: entry
              ? {
                  ...read.target,
                  storeKey: read.key,
                  storeKeys: [read.key],
                  readSource: read.readSource,
                  entry,
                }
              : null,
            members: listSessionMembersInDatabase(read.retained.database, read.key).map(
              (member) => member.identityId,
            ),
          },
        );
      }
    };
    assertCurrent();
    return { nativeSource: true, checks: [], assertCurrent, release };
  } catch (error) {
    await releaseSessionSourceAuthorities(resources, [error]);
    throw error;
  }
}

export function captureSessionSharingTalkAuthority({
  request,
  input,
  target,
  authorizesAgentRun,
}: {
  request: SessionMutationAuthorizationParams;
  input: ReturnType<typeof resolveTalkSessionTargetInput>;
  target: PreparedTalkSessionTarget | undefined;
  authorizesAgentRun: boolean;
}) {
  return (cfg: OpenClawConfig) => {
    if (!input || !target) {
      return;
    }
    let current: PreparedTalkSessionTarget;
    try {
      if (input.kind === "relay") {
        if (!input.isCurrent()) {
          throw sessionMutationTargetChanged(request.method, target.sessionKey);
        }
        assertTalkSessionStorageTarget(cfg, target);
        current = target;
      } else {
        current = prepareTalkSessionTarget(cfg, input.sessionKey);
      }
    } catch {
      throw sessionMutationTargetChanged(request.method, target.sessionKey);
    }
    if (
      current.agentId !== target.agentId ||
      current.sessionKey !== target.sessionKey ||
      current.canonicalKey !== target.canonicalKey ||
      current.storePath !== target.storePath
    ) {
      throw sessionMutationTargetChanged(request.method, target.sessionKey);
    }
    const error =
      authorizesAgentRun &&
      authorizeGatewaySessionCreation({
        cfg: request.context.getCommittedRuntimeConfig?.() ?? cfg,
        client: request.client,
        agentId: current.agentId,
      });
    if (error) {
      throw new SessionMutationAuthorizationChangedError(error);
    }
  };
}

export function isSameSessionSharingSource(
  current: Pick<SessionSharingTarget, "readSource" | "storePath">,
  expected: Pick<SessionSharingTarget, "readSource" | "storePath">,
): boolean {
  const source = expected.readSource;
  return source
    ? current.readSource?.databaseIdentity === source.databaseIdentity &&
        current.readSource.databaseBirthtime === source.databaseBirthtime &&
        current.readSource.agentId === source.agentId
    : current.storePath === expected.storePath;
}

export function resolveSessionSharingMembership(
  target: SessionSharingTarget,
  identityId: string | undefined,
  members: readonly string[] | undefined,
  projection: SessionRowProjection | undefined,
): boolean | undefined {
  return members
    ? Boolean(identityId && members.includes(identityId))
    : projection &&
        Boolean(
          identityId && projection.hasMembership(target.storePath, target.storeKey, identityId),
        );
}
