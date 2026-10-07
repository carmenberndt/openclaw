/** Durable per-agent voice-call records for Talk continuity and mutation evidence. */
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  publishTranscriptUpdate,
} from "../config/sessions/session-accessor.js";
import { appendExpectedSessionTranscriptTurn } from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import type { SessionTranscriptWriteScope } from "../config/sessions/session-accessor.types.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import { isNativeSessionEntryRead } from "../config/sessions/session-entry-read-request.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import {
  type ClientVoiceConfirmationUtteranceContext,
  deactivateClientVoiceConfirmationSession,
  noteClientVoiceConfirmationUtterance,
  prepareClientVoiceConfirmationTranscript,
  recordClientVoiceConfirmationTranscriptAppend,
  releaseClientVoiceConfirmationRun,
} from "./client-voice-confirmation.js";
import {
  CLIENT_VOICE_MUTATION_DIGEST_POLICY,
  ClientVoiceMutationDigestOwner,
  deliverClientVoiceMutationDigest,
} from "./client-voice-mutation-digest-owner.js";
import { withClientVoiceSessionSettlement } from "./client-voice-session-lifecycle.js";
import { lookupClientVoiceSessions } from "./client-voice-session-read.js";
import {
  assertVoiceSessionOwnership as assertOwnership,
  type ClientVoiceRunBinding,
  type ClientVoiceSessionRecord,
  operationKey,
  readVoiceSessionRecord as readRecord,
  readVoiceSessionFacts,
  VOICE_SESSION_STALE_AFTER_MS as STALE_AFTER_MS,
} from "./client-voice-session-store.js";
import {
  captureClientVoiceSessionWriter,
  type ClientVoiceSessionWriter,
} from "./client-voice-session-write.js";
import {
  buildPersistedVoiceMessage,
  VoiceTranscriptOperationRegistry,
  normalizeVoiceTranscriptText,
  voiceTranscriptEventId,
} from "./voice-transcript.js";

const voiceSessionByRunId = new Map<string, ClientVoiceRunBinding>();
const voiceSessionOperations = new VoiceTranscriptOperationRegistry();
let unsubscribeToolEffects: (() => void) | undefined;
let unsubscribeRunCompletion: (() => void) | undefined;

function hasLiveConsultRun(record: ClientVoiceSessionRecord): boolean {
  return record.consultRunIds.some((runId) => {
    const binding = voiceSessionByRunId.get(runId);
    return (
      binding?.agentId === record.agentId &&
      binding.voiceSessionId === record.voiceSessionId &&
      binding.sessionKey === record.sessionKey
    );
  });
}

async function closeVoiceSessionOperationOwner(
  params: Omit<Parameters<typeof closeClientVoiceSessionInternal>[0], "writer">,
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<boolean> {
  return withClientVoiceSessionSettlement(async () => {
    const writer = retainedWriter ?? captureClientVoiceSessionWriter(params);
    try {
      let closed: boolean | undefined;
      await voiceSessionOperations.close(
        operationKey(params.agentId, params.voiceSessionId),
        async () => {
          closed = await closeClientVoiceSessionInternal({ ...params, writer });
        },
      );
      // A joined recovery close may skip a resumed call; explicit closes need their own barrier.
      if (closed === undefined && params.staleBefore === undefined) {
        return await closeVoiceSessionOperationOwner(params, writer);
      }
      return closed ?? false;
    } finally {
      if (!retainedWriter) {
        await writer.release();
      }
    }
  });
}

function recordClientVoiceToolEffect(event: TrustedToolExecutionEvent): void {
  const binding = event.runId ? voiceSessionByRunId.get(event.runId) : undefined;
  if (!binding) {
    return;
  }
  // Capture the source and enqueue synchronously, before run.completed can retire its binding.
  void withClientVoiceSessionSettlement(async () => {
    const writer = captureClientVoiceSessionWriter(binding);
    try {
      await writer.mutate({ ...binding, kind: "effect", event, now: Date.now() });
    } finally {
      await writer.release();
    }
  }).catch((error: unknown) => {
    console.warn(`[talk] voice tool effect persistence failed: ${String(error)}`);
  });
}

function ensureToolEffectSubscription(): void {
  unsubscribeToolEffects ??= onTrustedToolExecutionEvent(recordClientVoiceToolEffect);
  unsubscribeRunCompletion ??= onTrustedInternalDiagnosticEvent(
    (event) => {
      if (event.type !== "run.completed") {
        return;
      }
      const binding = voiceSessionByRunId.get(event.runId);
      if (!binding) {
        return;
      }
      voiceSessionByRunId.delete(event.runId);
      releaseClientVoiceConfirmationRun(binding.agentId, binding.voiceSessionId, event.runId);
      mutationDigestDeliveryOwner.retry(binding);
    },
    { include: ["run.completed"] },
  );
}

export { createOrResumeClientVoiceSession } from "./client-voice-session-write.js";

/** Read the canonical agent-session id without creating state during provider startup. */
export function resolveClientVoiceAgentSessionId(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
}): string | undefined {
  return loadSessionEntryReadOnly(params)?.sessionId?.trim() || undefined;
}

/** Ensure Talk has the same canonical agent-session row that chat turns append to. */
export async function ensureClientVoiceAgentSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  deadlineAt?: number;
  assertCommitAllowed?: () => void;
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

/** Correlate a consult run with its open call for confirmation and mutation evidence. */
export async function registerClientVoiceConsultRun(input: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  runId: string;
  config?: OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<() => void> {
  const params = { ...input };
  return withClientVoiceSessionSettlement(async () => {
    const writer = captureClientVoiceSessionWriter(params);
    try {
      return await writer.mutate(
        {
          kind: "consult",
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          voiceSessionId: params.voiceSessionId,
          runId: params.runId,
          now: Date.now(),
        },
        (record) => {
          const previousBinding = voiceSessionByRunId.get(params.runId);
          if (
            previousBinding &&
            (previousBinding.agentId !== params.agentId ||
              previousBinding.voiceSessionId !== params.voiceSessionId)
          ) {
            // A run ID has one authoritative voice scope. Replacing it must retire the
            // prior scope's post-close grant or completion can no longer find that owner.
            releaseClientVoiceConfirmationRun(
              previousBinding.agentId,
              previousBinding.voiceSessionId,
              params.runId,
            );
          }
          if (
            previousBinding?.agentId !== params.agentId ||
            previousBinding.voiceSessionId !== params.voiceSessionId ||
            previousBinding.sessionKey !== params.sessionKey
          ) {
            // Replays keep the operational claim; a reassignment must never revive it.
            voiceSessionByRunId.set(
              params.runId,
              Object.freeze({
                agentId: params.agentId,
                voiceSessionId: params.voiceSessionId,
                sessionKey: params.sessionKey,
              }),
            );
          }
          // Bound to a call that already closed: re-arm the point-in-time summary owner so
          // the run completion becomes a retry point without coupling it to transcript work.
          if (record?.status === "closed" && params.config) {
            mutationDigestDeliveryOwner.record({
              agentId: params.agentId,
              voiceSessionId: params.voiceSessionId,
              context: params.config,
            });
          }
          ensureToolEffectSubscription();
          const binding = voiceSessionByRunId.get(params.runId);
          return () => {
            if (!binding || voiceSessionByRunId.get(params.runId) !== binding) {
              return;
            }
            voiceSessionByRunId.delete(params.runId);
            releaseClientVoiceConfirmationRun(params.agentId, params.voiceSessionId, params.runId);
            mutationDigestDeliveryOwner.retry(binding);
          };
        },
      );
    } finally {
      await writer.release();
    }
  });
}

/** Return the open voice-call binding for one executing run. */
export function resolveClientVoiceRunBinding(runId?: string): ClientVoiceRunBinding | undefined {
  return runId ? voiceSessionByRunId.get(runId) : undefined;
}

/**
 * Confirmation applies only when the session can observe spoken approvals:
 * relay sessions (server hears utterances) or clients that report transcripts.
 * Legacy clients without transcript reporting keep pre-gate behavior.
 */
export function isClientVoiceSessionConfirmable(binding: ClientVoiceRunBinding): boolean {
  const record = readVoiceSessionFacts(binding.agentId, binding.voiceSessionId);
  return (
    record?.origin === "relay" ||
    record?.transcriptCapable === true ||
    record?.hasUserTranscript === true
  );
}

function requireOwnedVoiceSession(params: ClientVoiceRunBinding) {
  const record = readVoiceSessionFacts(params.agentId, params.voiceSessionId);
  if (!record) {
    throw new Error("voice session not found");
  }
  assertOwnership(record, params);
  return record;
}

/** Validate ownership and open state before starting a voice-bound consult. */
export function assertClientVoiceSessionOpen(params: ClientVoiceRunBinding): "client" | "relay" {
  const record = requireOwnedVoiceSession(params);
  if (record.status !== "open") {
    throw new Error("voice session is closed");
  }
  return record.origin;
}

/** Validate durable ownership without rejecting an idempotent close retry. */
export function resolveClientVoiceSessionOrigin(params: ClientVoiceRunBinding): "client" | "relay" {
  return requireOwnedVoiceSession(params).origin;
}

/** Resolve the unique open client-owned call for legacy tool-call clients. */
export async function resolveOpenClientVoiceSessionId(params: {
  agentId: string;
  sessionKey: string;
}): Promise<string | undefined> {
  const matches = await lookupClientVoiceSessions({ kind: "legacy", ...params });
  return matches.length === 1 ? matches[0]?.voiceSessionId : undefined;
}

function appendVoiceTranscript(
  params: {
    agentId: string;
    sessionKey: string;
    sessionTarget: { sessionKey: string; storePath?: string };
    voiceSessionId: string;
    origin: "client" | "relay";
    entryId: string;
    role: "user" | "assistant";
    text: string;
    timestamp?: number;
    config?: OpenClawConfig;
    confirmation?: ClientVoiceConfirmationUtteranceContext | null;
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  // Normalize before admission so the queued task retains only bounded text.
  const normalized = {
    ...params,
    sessionTarget: { ...params.sessionTarget },
    text: normalizeVoiceTranscriptText(params.text),
  };
  if (!normalized.text) {
    return Promise.resolve();
  }
  const confirmation =
    normalized.role === "user"
      ? prepareClientVoiceConfirmationTranscript({
          agentId: normalized.agentId,
          voiceSessionId: normalized.voiceSessionId,
          entryId: normalized.entryId,
          confirmation: normalized.confirmation,
        })
      : null;
  return withClientVoiceSessionSettlement(async () => {
    const writer = retainedWriter ?? captureClientVoiceSessionWriter(normalized);
    try {
      await voiceSessionOperations.run(
        operationKey(normalized.agentId, normalized.voiceSessionId),
        async () => {
          const sessionTarget = {
            ...normalized.sessionTarget,
            agentId: normalized.agentId,
            env: writer.options.env,
          };
          const failureKey = sha256Hex(normalized.entryId);
          const timestamp = normalized.timestamp ?? Date.now();
          const reservation = {
            agentId: normalized.agentId,
            sessionKey: normalized.sessionKey,
            voiceSessionId: normalized.voiceSessionId,
            origin: normalized.origin,
            kind: "reserve" as const,
            failureKey,
            now: Date.now(),
          };
          const appendReserved = async (
            record: ClientVoiceSessionRecord | undefined,
            entry: InternalSessionEntry | undefined,
            target: SessionTranscriptWriteScope,
            assertFresh: () => void,
            workerTranscript = false,
          ) => {
            if (!record) {
              throw new Error("voice session not found");
            }
            if (!entry?.sessionId) {
              throw new Error(`agent session not found (${normalized.sessionKey})`);
            }
            const transcriptTarget = { ...target, sessionId: entry.sessionId };
            const messageOptions = {
              ...(normalized.config ? { config: normalized.config } : {}),
              eventId: voiceTranscriptEventId(normalized.voiceSessionId, normalized.entryId),
              message: buildPersistedVoiceMessage({
                role: normalized.role,
                text: normalized.text,
                timestamp,
                provider: record.provider ?? "realtime",
              }),
              now: timestamp,
            };
            const turn = workerTranscript
              ? await appendExpectedSessionTranscriptTurn(transcriptTarget, {
                  config: normalized.config,
                  keyFormat: "agent-qualified",
                  expectedSessionId: entry.sessionId,
                  selectedSessionId: entry.sessionId,
                  selectedLifecycleRevision: entry.lifecycleRevision,
                  sessionFile: normalized.sessionTarget.sessionKey,
                  assertCurrent: assertFresh,
                  messages: [messageOptions],
                  voiceTranscript: {
                    agentId: normalized.agentId,
                    sessionKey: normalized.sessionKey,
                    voiceSessionId: normalized.voiceSessionId,
                    failureKey,
                    role: normalized.role,
                  },
                })
              : undefined;
            const appended = workerTranscript
              ? turn?.appendedMessages[0]
              : await appendTranscriptMessage(transcriptTarget, {
                  ...messageOptions,
                  beforeFreshMessageCommit: assertFresh,
                });
            if (!appended) {
              throw new Error("agent session changed before voice transcript append");
            }
            // The worker publishes the transcript and its bookkeeping only after their shared commit.
            if (confirmation) {
              recordClientVoiceConfirmationTranscriptAppend({
                confirmation,
                entryId: normalized.entryId,
                text: normalized.text,
                appended: appended.appended,
              });
            }
            if (appended.appended) {
              await publishTranscriptUpdate(transcriptTarget, {
                message: appended.message,
                messageId: appended.messageId,
              });
            }

            const confirmed = workerTranscript
              ? turn?.voiceSession
              : await writer.mutate({
                  agentId: normalized.agentId,
                  sessionKey: normalized.sessionKey,
                  voiceSessionId: normalized.voiceSessionId,
                  kind: "confirm",
                  role: normalized.role,
                  failureKey,
                  now: Date.now(),
                });
            if (normalized.role === "user" && confirmation) {
              if (!confirmed?.hasUserTranscript) {
                throw new Error("voice transcript confirmation was not committed");
              }
              noteClientVoiceConfirmationUtterance({
                agentId: normalized.agentId,
                voiceSessionId: normalized.voiceSessionId,
                timestamp: Date.now(),
                confirmation,
              });
            }
          };
          const sharesVoiceStore =
            !isNativeSessionEntryRead(sessionTarget, normalized.agentId) &&
            (!sessionTarget.storePath ||
              resolveUnsuffixedSqliteTargetFromSessionStorePath(sessionTarget.storePath).path ===
                writer.options.path);
          if (sharesVoiceStore) {
            // Entry preparation and failure reservation share their authoritative transaction.
            const prepared = await writer.mutate(
              { ...reservation, transcriptSessionKey: sessionTarget.sessionKey },
              (record, entry) => ({ record, entry }),
            );
            await appendReserved(
              prepared.record,
              prepared.entry,
              {
                ...sessionTarget,
                storePath: writer.options.path,
              },
              writer.assertCurrent,
              true,
            );
          } else {
            // Custom and native incognito transcripts keep their separately selected source.
            await withSessionEntryReadOnlyInWorker(
              sessionTarget,
              writer.assertCurrent,
              async (read, source) => {
                if (!read.ok) {
                  throw read.error;
                }
                if (!read.value?.sessionId) {
                  throw new Error(`agent session not found (${normalized.sessionKey})`);
                }
                const physicalSource = source.scope?.storePath
                  ? readDatabasePathIdentitySync(source.scope.storePath)
                  : undefined;
                const record = await writer.mutate(reservation);
                source.assertCurrent();
                await appendReserved(
                  record,
                  read.value,
                  { ...sessionTarget, ...source.scope },
                  () => {
                    writer.assertCurrent();
                    // Canonical reader continuations cannot enter the append's transaction.
                    if (physicalSource) {
                      assertExistingDatabaseIdentity(
                        physicalSource.canonicalPath,
                        physicalSource.key,
                        physicalSource.birthtime,
                      );
                    }
                  },
                );
              },
            );
          }
        },
        { weight: normalized.text.length },
      );
    } finally {
      if (!retainedWriter) {
        await writer.release();
      }
    }
  });
}

/** Append one finalized client-owned transcript item idempotently. */
export function appendClientVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  return appendVoiceTranscript({ ...params, origin: "client" }, retainedWriter);
}

/** Wait for the accepted transcript/effect prefix without closing the logical call. */
export async function flushClientVoiceSessionWrites(
  params: {
    agentId: string;
    voiceSessionId: string;
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  const writer = retainedWriter ?? captureClientVoiceSessionWriter(params);
  try {
    await voiceSessionOperations.flush(operationKey(params.agentId, params.voiceSessionId));
    // Join the accepted agent-writer prefix, including synchronous diagnostic producers.
    await runOpenClawAgentWriteAdmission(writer.options, () => writer.assertCurrent());
  } finally {
    if (!retainedWriter) {
      await writer.release();
    }
  }
}

/** Append one finalized relay-owned transcript item idempotently. */
export function appendRelayVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  return appendVoiceTranscript({ ...params, origin: "relay" }, retainedWriter);
}

const mutationDigestDeliveryOwner = new ClientVoiceMutationDigestOwner<OpenClawConfig>({
  attempt: ({ agentId, voiceSessionId, context: config, signal }) =>
    withClientVoiceSessionSettlement(async () => {
      // Deferral needs no database read while the live run owner still holds the call.
      if (
        [...voiceSessionByRunId.values()].some(
          (binding) => binding.agentId === agentId && binding.voiceSessionId === voiceSessionId,
        )
      ) {
        return false;
      }
      const writer = captureClientVoiceSessionWriter({ agentId });
      try {
        const prepared = await writer.read(voiceSessionId);
        const record = prepared?.record;
        if (!record) {
          return true;
        }
        if (record.status !== "closed" || hasLiveConsultRun(record)) {
          return false;
        }
        await deliverClientVoiceMutationDigest(record, config, signal, writer, prepared?.entry);
        return true;
      } finally {
        await writer.release();
      }
    }),
  warn: (message) => console.warn(`[talk] deferred voice mutation digest failed: ${message}`),
});

async function closeClientVoiceSessionInternal(params: {
  writer: ClientVoiceSessionWriter;
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  config: OpenClawConfig;
  transcriptFailurePolicy: "require-success" | "retain-and-close";
  now?: number;
  staleBefore?: number;
}): Promise<boolean> {
  const now = params.now ?? Date.now();
  const closed = await params.writer.mutate({
    kind: "close",
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    voiceSessionId: params.voiceSessionId,
    transcriptFailurePolicy: params.transcriptFailurePolicy,
    staleBefore: params.staleBefore,
    now,
  });
  if (!closed) {
    return false;
  }
  // Transport close does not end consult runs: live bindings keep effect capture active,
  // approved grants stay valid for those runs, and the digest waits for the last run.completed.
  const liveRunIds = closed.consultRunIds.filter((runId) => {
    const binding = voiceSessionByRunId.get(runId);
    return binding?.voiceSessionId === params.voiceSessionId && binding.agentId === params.agentId;
  });
  deactivateClientVoiceConfirmationSession(params.agentId, params.voiceSessionId, liveRunIds);
  // Record retry ownership only after canonical close and confirmation cleanup.
  // Channel delivery is best-effort and must never delay this durable boundary.
  mutationDigestDeliveryOwner.record({
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
    context: params.config,
  });
  return true;
}

/** Close a logical voice call after its accepted transcript prefix is durable. */
export async function closeClientVoiceSession(
  params: {
    agentId: string;
    sessionKey: string;
    voiceSessionId: string;
    config: OpenClawConfig;
    now?: number;
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  await closeVoiceSessionOperationOwner(
    {
      ...params,
      transcriptFailurePolicy: "require-success",
    },
    retainedWriter,
  );
}

/**
 * Terminally close a relay call after its bounded append retries settle.
 * Relays have no payload replay owner after teardown, so unresolved hashes remain as audit state.
 */
export async function closeRelayVoiceSessionRecord(
  params: {
    agentId: string;
    sessionKey: string;
    voiceSessionId: string;
    config: OpenClawConfig;
    now?: number;
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  await closeVoiceSessionOperationOwner(
    {
      ...params,
      transcriptFailurePolicy: "retain-and-close",
    },
    retainedWriter,
  );
}

/** Close abandoned open calls idle for the fixed six-hour recovery window. */
export async function closeStaleClientVoiceSessions(params: {
  agentId: string;
  config: OpenClawConfig;
  excludeVoiceSessionId?: string;
  now?: number;
  warn?: (message: string) => void;
}): Promise<number> {
  const now = params.now ?? Date.now();
  // A new voice session remains a retry point, but channel I/O is detached so a
  // stalled adapter cannot block stale-session recovery.
  mutationDigestDeliveryOwner.retryAgent(params.agentId, params.config);
  const stale = await lookupClientVoiceSessions({
    kind: "stale",
    agentId: params.agentId,
    updatedBefore: now - STALE_AFTER_MS,
    excludeVoiceSessionId: params.excludeVoiceSessionId,
  });
  let closed = 0;
  for (const record of stale) {
    try {
      const didClose = await closeVoiceSessionOperationOwner({
        agentId: params.agentId,
        sessionKey: record.sessionKey,
        voiceSessionId: record.voiceSessionId,
        config: params.config,
        now,
        staleBefore: now - STALE_AFTER_MS,
        transcriptFailurePolicy: "require-success",
      });
      if (didClose) {
        closed += 1;
      }
    } catch (error) {
      params.warn?.(
        `failed to close stale voice session ${record.voiceSessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return closed;
}

const clientVoiceSessionTesting = {
  readRecord,
  digestDeliveryPolicy: CLIENT_VOICE_MUTATION_DIGEST_POLICY,
  digestDeliverySnapshot: () => mutationDigestDeliveryOwner.snapshot(),
  reset(): void {
    voiceSessionByRunId.clear();
    voiceSessionOperations.clear();
    mutationDigestDeliveryOwner.clear();
    unsubscribeToolEffects?.();
    unsubscribeToolEffects = undefined;
    unsubscribeRunCompletion?.();
    unsubscribeRunCompletion = undefined;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.clientVoiceSessionTestApi")] =
    clientVoiceSessionTesting;
}
