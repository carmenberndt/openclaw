import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { withClientVoiceSessionSettlement } from "../../../talk/client-voice-session-lifecycle.js";
import {
  captureClientVoiceSessionWriter,
  type ClientVoiceSessionWriter,
} from "../../../talk/client-voice-session-write.js";
import {
  appendRelayVoiceTranscript,
  closeRelayVoiceSessionRecord,
  createOrResumeClientVoiceSession,
} from "../../../talk/client-voice-session.js";
import {
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "../../../talk/voice-transcript.js";
import { sleep } from "../../../utils/sleep.js";
import { drainingRelaySessions, type RelaySession } from "./state.js";

const RELAY_TRANSCRIPT_RETRY_DELAYS_MS = [0, 500, 2_000] as const;

function logRelayVoiceFailure(session: RelaySession, message: string, error: unknown): void {
  session.context.logGateway?.warn(`${message}: ${formatErrorMessage(error)}`);
}

export function ensureRelayVoiceSession(session: RelaySession): Promise<boolean> {
  if (session.voiceSessionCreated) {
    return Promise.resolve(true);
  }
  const { agentId, sessionKey } = session.sessionTarget;
  session.voiceSessionCreation ??= createOrResumeClientVoiceSession({
    agentId,
    sessionKey,
    provider: session.provider,
    origin: "relay",
    voiceSessionId: session.id,
  })
    .then(() => {
      session.voiceSessionCreated = true;
      return true;
    })
    .catch((error: unknown) => {
      if (!hasSqliteWorkerOutcomeUnknown(error)) {
        session.voiceSessionCreation = undefined;
      }
      logRelayVoiceFailure(session, "realtime relay voice session create failed", error);
      return false;
    });
  return session.voiceSessionCreation;
}

export function enqueueRelayVoiceTranscript(
  session: RelaySession,
  role: "user" | "assistant",
  text: string,
): boolean {
  const observed =
    role === "user" && !session.closing
      ? session.confirmationReadiness.observeUserTranscript(text, true)
      : undefined;
  const normalizedText = normalizeVoiceTranscriptText(text);
  if (!normalizedText) {
    return true;
  }
  const transcriptSeq = session.voiceTranscriptSeq + 1;
  const entryId = String(transcriptSeq);
  const { agentId, sessionKey, canonicalKey, storePath } = session.sessionTarget;
  let accepted = false;
  let rejection: string | undefined;
  const reportFailure = (error: unknown) => {
    session.confirmationReadiness.fail(error);
    logRelayVoiceFailure(session, "realtime relay transcript append failed", error);
  };
  const completion = withClientVoiceSessionSettlement(async () => {
    const writer = captureClientVoiceSessionWriter({ agentId });
    try {
      const voiceSessionReady = ensureRelayVoiceSession(session);
      const admission = session.voiceTranscriptQueue.enqueue(
        async () => {
          if (!(await voiceSessionReady)) {
            throw new Error("Realtime voice session could not be recorded");
          }
          let lastError: unknown;
          for (const delayMs of RELAY_TRANSCRIPT_RETRY_DELAYS_MS) {
            if (delayMs > 0) {
              await sleep(delayMs);
            }
            try {
              await appendRelayVoiceTranscript(
                {
                  agentId,
                  sessionKey,
                  sessionTarget: { sessionKey: canonicalKey, storePath },
                  voiceSessionId: session.id,
                  entryId,
                  role,
                  text: normalizedText,
                  confirmation: observed?.confirmation ?? null,
                  ...(session.voiceConfig ? { config: session.voiceConfig } : {}),
                },
                writer,
              );
              return;
            } catch (error) {
              if (hasSqliteWorkerOutcomeUnknown(error)) {
                throw error;
              }
              lastError = error;
            }
          }
          throw lastError;
        },
        { weight: normalizedText.length },
      );
      accepted = admission.accepted;
      if (!admission.accepted) {
        rejection = admission.reason;
        return;
      }
      session.voiceTranscriptSeq = transcriptSeq;
      await admission.completion.then(observed?.persisted, reportFailure);
    } finally {
      await writer.release();
    }
  });
  void completion.catch(reportFailure);
  if (!accepted) {
    session.confirmationReadiness.fail(
      new Error("Realtime voice transcript queue is closed or full"),
    );
    if (rejection === "overflow") {
      session.failSession(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    }
    return false;
  }
  return true;
}

export function closeRelayVoiceSession(
  session: RelaySession,
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  if (session.voiceSessionClose) {
    return session.voiceSessionClose;
  }
  session.voiceTranscriptQueue.seal();
  const { agentId, sessionKey } = session.sessionTarget;
  session.voiceSessionClose = withClientVoiceSessionSettlement(async () => {
    const writer = retainedWriter ?? captureClientVoiceSessionWriter({ agentId });
    try {
      const voiceSessionReady = ensureRelayVoiceSession(session);
      await session.voiceTranscriptQueue.flush();
      if (!(await voiceSessionReady)) {
        return;
      }
      const config = session.voiceConfig ?? session.context.getRuntimeConfig();
      await closeRelayVoiceSessionRecord(
        {
          agentId,
          sessionKey,
          voiceSessionId: session.id,
          config,
        },
        writer,
      );
    } finally {
      if (!retainedWriter) {
        await writer.release();
      }
    }
  }).catch((error: unknown) => {
    logRelayVoiceFailure(session, "realtime relay voice session close failed", error);
  });
  drainingRelaySessions.add(session);
  void session.voiceSessionClose.finally(() => {
    drainingRelaySessions.delete(session);
  });
  return session.voiceSessionClose;
}
