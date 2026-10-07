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
import { mergeSessionEntry, type InternalSessionEntry } from "../config/sessions/types.js";
import {
  assertDatabasePathIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
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
  return {
    options,
    identity: captured.identity,
    settlementContext: captured.settlementContext,
    get source(): ClientVoiceSessionSource {
      assertCurrent();
      const committed = execution.fileIdentity;
      if (committed) {
        return createClientVoiceSessionSource(options, {
          key: `file:${committed.physicalIdentity}`,
          birthtime: committed.birthtime,
          canonicalPath: committed.nativeLocation,
        });
      }
      if (existing) {
        return captured;
      }
      throw new Error("Voice session creation has not been acknowledged");
    },
    assertCurrent,
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
      const writer = retainedWriter ?? captureClientVoiceSessionWriter(params);
      const resources: Array<Pick<PreparedSessionSourceAuthority, "release">> = retainedWriter
        ? []
        : [writer];
      const errors: unknown[] = [];
      try {
        const requester = await prepareSessionSourceAuthority(params.requester);
        resources.push(requester);
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
        let native: ReturnType<typeof retainOpenClawAgentDatabaseReadOnly> | undefined;
        let authority: PreparedSessionSourceAuthority | undefined;
        if (!requester.nativeSource && params.source) {
          const sourcePath = resolveUnsuffixedSqliteTargetFromSessionStorePath(
            params.source.storePath,
          ).path;
          native =
            readDatabasePathIdentitySync(sourcePath).key !==
            readDatabasePathIdentitySync(writer.options.path).key
              ? retainOpenClawAgentDatabaseReadOnly({ ...writer.options, path: sourcePath })
              : undefined;
          if (native && !native.found) {
            throw new Error("Voice session source is unavailable");
          }
          if (native?.found) {
            resources.push(native.claim);
          }
          authority = await prepareSessionSourceAuthority(params.source.assertCurrent);
          resources.push(authority);
        }
        if (requester.nativeSource || authority?.opaqueCommitGuard) {
          params.source?.assertCurrent();
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
            writer.assertCurrent();
            requester.assertCurrent();
            authority?.assertCurrent();
            params.requester?.();
            params.source?.assertCurrent();
          };
          await runOpenClawAgentWriteAdmission(
            writer.options,
            async () => {
              assertDatabasePathIdentity(writer.options.path, writer.identity);
              await withOpenClawAgentDatabaseAsync(
                writer.options,
                () =>
                  runOpenClawAgentWriteWithYieldingAdmission(
                    (database) => {
                      assertNativeCurrent();
                      kernel.mutateVoiceSessionInDatabase(database, mutation);
                      assertNativeCurrent();
                    },
                    writer.options,
                    { operationLabel: "voice.session.create" },
                  ),
                assertNativeCurrent,
              );
            },
            true,
          );
        } else {
          if (native?.found && authority && params.source) {
            const prepared = authority;
            const assertion = params.source.assertCurrent;
            // The released synchronous SDK keeps cross-store authority native; pin its reader before waiting.
            authority = {
              checks: [],
              assertCurrent: () => {
                native.claim.assertCurrent();
                prepared.assertCurrent();
                if (prepared.checks.length > 0) {
                  assertion();
                }
              },
            };
          }
          await writer.mutate(mutation, undefined, {
            checks: [...requester.checks, ...(authority?.checks ?? [])],
            assertCurrent: () => {
              requester.assertCurrent();
              authority?.assertCurrent();
            },
          });
        }
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
