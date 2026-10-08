import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import {
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourcePredicateFacts,
} from "../config/sessions/session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
  isSessionStoreReadCandidateCurrent,
} from "../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import { mergeSessionEntry, type InternalSessionEntry } from "../config/sessions/types.js";
import { assertDatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import {
  assertClientVoiceSessionSettlementCurrent,
  withClientVoiceSessionSettlement,
} from "./client-voice-session-lifecycle.js";
import {
  captureClientVoiceSessionSource,
  createClientVoiceSessionSource,
  prepareClientVoiceSessionSourceChecks,
  type ClientVoiceSessionSource,
} from "./client-voice-session-source.js";
import type { ClientVoiceSessionRecord } from "./client-voice-session-store.js";
import type { VoiceSessionMutation } from "./client-voice-session-write.kernel.js";

/** Voice metadata keeps its durable agent owner, including for incognito transcripts. */
export function captureClientVoiceSessionWriter(params: {
  agentId: string;
  assertCurrent?: () => void;
  physicalSource?: ClientVoiceSessionSource;
}) {
  const captured = params.physicalSource ?? captureClientVoiceSessionSource(params.agentId);
  const options = captured.options;
  captured.assertCurrent();
  const existing = captured.identity.key.startsWith("file:");
  const execution = captureOpenClawAgentDatabaseExecution(
    options,
    existing
      ? {
          expectedIdentity: {
            kind: "file",
            physicalIdentity: captured.identity.key.slice("file:".length),
            birthtime: captured.identity.birthtime,
            nativeLocation: captured.identity.canonicalPath,
          },
        }
      : { expectedCreationIdentity: captured.identity },
  );
  const assertCurrent = () => {
    assertClientVoiceSessionSettlementCurrent(captured.settlementContext);
    execution.assertCurrent();
    if (existing) {
      captured.assertCurrent();
    }
    params.assertCurrent?.();
  };
  const createSource = (
    authority?: PreparedSessionSourceAuthority,
  ): AgentDatabaseRequestExecutionSource => ({
    assertCurrent: () => {
      assertCurrent();
      authority?.assertCurrent();
    },
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          const facts = isRecord(request.facts) ? request.facts.publication : undefined;
          if (
            isRecord(facts) &&
            facts.kind === "voice-session-source" &&
            typeof facts.index === "number"
          ) {
            // The paired worker compares these source rows in its current transaction.
            authority?.checks[facts.index]?.refuse(facts.facts as SessionSourcePredicateFacts);
            throw new Error("Voice session source refusal omitted its prepared assertion");
          }
          if (!grant()) {
            throw new Error("Voice session write authority expired");
          }
        }, binding.attachment),
      });
    },
  });
  function mutate(
    input: VoiceSessionMutation,
    publish?: undefined,
    authority?: PreparedSessionSourceAuthority,
  ): Promise<ClientVoiceSessionRecord | undefined>;
  function mutate<T>(
    input: VoiceSessionMutation,
    publish: (record: ClientVoiceSessionRecord | undefined, entry?: InternalSessionEntry) => T,
  ): Promise<T>;
  async function mutate<T>(
    input: VoiceSessionMutation,
    publish?: (record: ClientVoiceSessionRecord | undefined, entry?: InternalSessionEntry) => T,
    authority?: PreparedSessionSourceAuthority,
  ): Promise<T | ClientVoiceSessionRecord | undefined> {
    const mutation = structuredClone(input);
    const source = createSource(authority);
    return runOpenClawAgentWorkerWrite(options, async () => {
      if (mutation.kind === "create") {
        await execution.prepare(source);
      }
      const result = await execution.runExisting(source, async (worker) => {
        const committed = await worker.execute({
          type: "voice.session.mutate",
          input: {
            ...mutation,
            ...(authority?.checks.length
              ? { sources: authority.checks.map((check) => check.predicate) }
              : {}),
          },
        });
        // Install acknowledged facts before releasing the existing writer FIFO.
        return {
          value: publish ? publish(committed.record, committed.entry) : committed.record,
        };
      });
      if (!result) {
        throw new Error("Voice session database is missing");
      }
      return result.value;
    });
  }
  const readCommittedIdentity = () => {
    const committed = execution.fileIdentity;
    return (
      committed && {
        key: `file:${committed.physicalIdentity}`,
        birthtime: committed.birthtime,
        canonicalPath: committed.nativeLocation,
      }
    );
  };
  return {
    options,
    get identity() {
      return readCommittedIdentity() ?? captured.identity;
    },
    settlementContext: captured.settlementContext,
    get source(): ClientVoiceSessionSource {
      assertCurrent();
      const committed = readCommittedIdentity();
      if (committed) {
        return createClientVoiceSessionSource(options, committed);
      }
      if (existing) {
        return captured;
      }
      throw new Error("Voice session creation has not been acknowledged");
    },
    assertCurrent,
    adoptNativeDatabase: execution.adoptNativeDatabase,
    release: () => execution.release(),
    read(voiceSessionId: string) {
      return runOpenClawAgentWorkerWrite(options, () =>
        execution.runExisting(createSource(), async (worker) => {
          const result = await worker.execute({
            type: "voice.session.read",
            input: { voiceSessionId },
          });
          assertCurrent();
          return result;
        }),
      );
    },
    mutate,
  };
}

export type ClientVoiceSessionWriter = ReturnType<typeof captureClientVoiceSessionWriter>;

/** Ensure Talk has the same canonical agent-session row that chat turns append to. */
export async function ensureClientVoiceAgentSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  deadlineAt?: number;
  assertCommitAllowed?: () => void;
  onCommitted?: (entry: InternalSessionEntry) => void;
  creation?: Pick<Parameters<typeof buildSessionCreationStamp>[0], "actor" | "sandbox">;
}): Promise<string> {
  const created = await patchSessionEntryCore(
    params,
    (_entry, context) => {
      if (context.existingEntry?.sessionId) {
        return null;
      }
      if (context.existingEntry) {
        return { sessionId: randomUUID() };
      }
      return buildSessionCreationStamp({
        via: "talk",
        actor: params.creation?.actor ?? { type: "human", source: "unknown" },
        sandbox: params.creation?.sandbox,
      });
    },
    {
      fallbackEntry: mergeSessionEntry(undefined, {}),
      onCommitted: params.onCommitted,
      assertCommitAllowed: () => {
        // Provider startup can end while this write is queued or being prepared.
        // Revalidate at commit so it cannot leave an unusable empty chat.
        params.assertCommitAllowed?.();
        if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
          throw new Error("Realtime browser session expired during startup; try again");
        }
      },
    },
  );
  if (!created?.sessionId) {
    throw new Error(`agent session could not be initialized (${params.sessionKey})`);
  }
  return created.sessionId;
}

/** Create a call record or resume the same open call across transport restarts. */
export async function createOrResumeClientVoiceSession(
  input: {
    agentId: string;
    sessionKey: string;
    provider?: string;
    origin: "client" | "relay";
    transcriptCapable?: boolean;
    voiceSessionId?: string;
    now?: number;
    assertCurrent?: () => void;
    requester?: SessionSourceAssertion;
    source?: { assertCurrent: SessionSourceAssertion; storePath: string };
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<string> {
  const params = { ...input };
  return withClientVoiceSessionSettlement(
    async () => {
      const voiceSessionId = params.voiceSessionId?.trim() || randomUUID();
      const writer = retainedWriter ?? captureClientVoiceSessionWriter({ agentId: params.agentId });
      const resources: Array<Pick<PreparedSessionSourceAuthority, "release">> = retainedWriter
        ? []
        : [writer];
      const errors: unknown[] = [];
      try {
        const sourceCandidates = params.source
          ? captureSessionStoreReadCandidates(params.source.storePath)
          : [];
        const sourceIdentities = captureSessionStoreCandidateIdentities(sourceCandidates);
        const assertSourceLocatorsCurrent = () => {
          if (!sourceCandidates.every(isSessionStoreReadCandidateCurrent)) {
            throw new Error("Voice session source changed");
          }
        };
        // Reserve accepted order before authority preparation yields, without a native write lock.
        await runOpenClawAgentWriteAdmission(
          writer.options,
          async () => {
            writer.assertCurrent();
            params.assertCurrent?.();
            const requester = await prepareSessionSourceAuthority(params.requester);
            resources.push(requester);
            params.assertCurrent?.();
            requester.assertCurrent();
            const mutation: VoiceSessionMutation = {
              kind: "create",
              agentId: params.agentId,
              sessionKey: params.sessionKey,
              voiceSessionId,
              provider: params.provider?.trim() || undefined,
              origin: params.origin,
              transcriptCapable: params.transcriptCapable,
              now: params.now ?? Date.now(),
            };
            let assertSourceIdentityCurrent: (() => void) | undefined;
            let authority: PreparedSessionSourceAuthority | undefined;
            if (params.source) {
              authority = await prepareSessionSourceAuthority(params.source.assertCurrent);
              resources.push(authority);
              const preparedSources = authority.checks
                .map(({ predicate }) => predicate.source)
                .filter((source) =>
                  [...sourceIdentities.values()].some(
                    (identity) =>
                      typeof source.databaseIdentity === "string" &&
                      identity.key === `file:${source.databaseIdentity}` &&
                      identity.birthtime === source.databaseBirthtime,
                  ),
                );
              const preparedSource = preparedSources.every(
                (source) => source.databaseIdentity === preparedSources[0]?.databaseIdentity,
              )
                ? preparedSources[0]
                : undefined;
              const canonical = resolveUnsuffixedSqliteTargetFromSessionStorePath(
                params.source.storePath,
              );
              // Reuse the prepared physical owner; opaque SDK sources resolve their original selector.
              const sourceTarget =
                preparedSource ??
                (canonical.agentId ||
                (authority.nativeSource &&
                  isIncognitoOpenClawAgentSqlitePath(canonical.path, writer.options))
                  ? { ...canonical, agentId: canonical.agentId ?? params.agentId }
                  : await prepareSqliteTargetFromSessionStorePath(params.source.storePath, {
                      agentId: params.agentId,
                      env: writer.options.env,
                    }));
              const sourcePath = assertSessionStoreReadCandidate(
                sourceTarget.path,
                sourceCandidates,
              );
              const sourceIdentity = sourceIdentities.get(sourcePath);
              if (!sourceTarget.agentId || !sourceIdentity) {
                throw new Error("Voice session source changed its captured database owner");
              }
              const assertSourceCurrent = () => {
                assertSourceLocatorsCurrent();
                assertSessionStoreReadCandidate(sourceTarget.path, sourceCandidates);
                assertDatabasePathIdentity(sourcePath, sourceIdentity);
              };
              writer.assertCurrent();
              params.assertCurrent?.();
              requester.assertCurrent();
              assertSourceCurrent();
              authority.assertCurrent();
              assertSourceCurrent();
              assertSourceIdentityCurrent = assertSourceCurrent;
              if (
                (sourceIdentity.key !== writer.identity.key ||
                  sourceIdentity.birthtime !== writer.identity.birthtime) &&
                (requester.nativeSource ||
                  authority.opaqueCommitGuard ||
                  authority.checks.length === 0)
              ) {
                const native = retainOpenClawAgentDatabaseReadOnly({
                  ...writer.options,
                  agentId: sourceTarget.agentId,
                  path: sourcePath,
                });
                if (!native.found) {
                  throw new Error("Voice session source is unavailable");
                }
                resources.push(native.claim);
                assertSourceIdentityCurrent = () => {
                  assertSourceCurrent();
                  native.claim.assertCurrent();
                };
              }
            }
            if (requester.nativeSource || authority?.opaqueCommitGuard) {
              // v2026.9.8 GatewayRequestHandlerOptions permits synchronous SQLite-reading SDK guards.
              const [
                { withOpenClawAgentDatabaseAsync },
                { runOpenClawAgentWriteWithYieldingAdmission },
                kernel,
              ] = await Promise.all([
                import("../state/openclaw-agent-db.js"),
                import("../state/openclaw-agent-db-transaction.js"),
                import("./client-voice-session-write.kernel.js"),
              ]);
              const assertNativeCurrent = () => {
                // An SDK guard need not check a source alias, even when it shares the writer's file.
                assertSourceLocatorsCurrent();
                assertSourceIdentityCurrent?.();
                writer.assertCurrent();
                params.assertCurrent?.();
                requester.assertCurrent();
                // Prepared native guards are live; typed predicates still need a native row check.
                if (requester.checks.length > 0) {
                  params.requester?.();
                }
                assertSourceIdentityCurrent?.();
                authority?.assertCurrent();
                if (authority && authority.checks.length > 0) {
                  params.source?.assertCurrent();
                }
                assertSourceIdentityCurrent?.();
              };
              await runOpenClawAgentWriteAdmission(
                writer.options,
                async () => {
                  assertDatabasePathIdentity(writer.options.path, writer.identity);
                  await withOpenClawAgentDatabaseAsync(
                    writer.options,
                    async (database) => {
                      await writer.adoptNativeDatabase(database);
                      return runOpenClawAgentWriteWithYieldingAdmission(
                        (database) => {
                          assertNativeCurrent();
                          kernel.mutateVoiceSessionInDatabase(database, mutation);
                          assertNativeCurrent();
                        },
                        writer.options,
                        { operationLabel: "voice.session.create" },
                      );
                    },
                    assertNativeCurrent,
                  );
                },
                true,
              );
            } else {
              const sources = await prepareClientVoiceSessionSourceChecks(
                writer,
                authority ? [requester, authority] : [requester],
              );
              resources.push(sources);
              await writer.mutate(mutation, undefined, {
                checks: sources.checks,
                assertCurrent: () => {
                  assertSourceLocatorsCurrent();
                  assertSourceIdentityCurrent?.();
                  params.assertCurrent?.();
                  sources.assertCurrent();
                },
              });
            }
          },
          true,
        );
      } catch (error) {
        errors.push(error);
      }
      await releaseSessionSourceAuthorities(resources, errors);
      return voiceSessionId;
    },
    undefined,
    retainedWriter?.settlementContext,
  );
}
