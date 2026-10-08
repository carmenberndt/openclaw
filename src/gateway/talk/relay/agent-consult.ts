import { registerClientVoiceConsultRun } from "../../../talk/client-voice-session.js";
import type { RealtimeVoiceAgentConsultRunner } from "../../../talk/provider-types.js";
import { abortChatRunById } from "../../chat-abort.js";
import type { TalkAgentConsultRequest } from "../client-agent-consult.types.js";
import type { RelaySession } from "./state.js";
import { ensureRelayVoiceSession } from "./voice.js";

type RelayAgentConsultRunner = RealtimeVoiceAgentConsultRunner & {
  adoptCompletionClaims: () => void;
  claimAppend: () => boolean;
  claimFailureAppend: () => boolean;
  revokeRequesterFinal?: () => void;
  steer?: RealtimeVoiceAgentConsultRunner;
};

export function bindTalkRealtimeRelayAgentConsult(
  runPrompt: RelayAgentConsultRunner,
  isCurrent: () => boolean,
  waitForTranscript: (signal?: AbortSignal) => Promise<void>,
) {
  const bindReadiness =
    (runner: RealtimeVoiceAgentConsultRunner, closedMessage: string) =>
    async (request: TalkAgentConsultRequest) => {
      if (!isCurrent()) {
        throw new Error(closedMessage);
      }
      await waitForTranscript(request.signal);
      if (!isCurrent()) {
        throw new Error(closedMessage);
      }
      return await runner(request);
    };
  const steer = runPrompt.steer;
  const lifecycleMethods = {
    adoptCompletionClaims: () => runPrompt.adoptCompletionClaims(),
    claimAppend: () => {
      const current = isCurrent();
      const claimed = runPrompt.claimAppend();
      return current && claimed;
    },
    claimFailureAppend: () => {
      const current = isCurrent();
      const claimed = runPrompt.claimFailureAppend();
      return current && claimed;
    },
    revokeRequesterFinal: () => runPrompt.revokeRequesterFinal?.(),
    ...(steer
      ? {
          steer: bindReadiness(steer, "Realtime relay session is no longer active"),
        }
      : {}),
  };
  return Object.assign(
    bindReadiness(runPrompt, "Realtime gateway-relay session is closed"),
    lifecycleMethods,
  );
}

export function createRelayAgentRunRegistration(
  getRelaySession: (relaySessionId: string, connId: string) => RelaySession,
) {
  return async function registerTalkRealtimeRelayAgentRun(params: {
    relaySessionId: string;
    connId: string;
    sessionKey: string;
    runId: string;
    callId?: string;
    assertCurrent?: () => void;
    registerVoice?: (assertCurrent: () => void) => Promise<() => void>;
  }): Promise<() => void> {
    const session = getRelaySession(params.relaySessionId, params.connId);
    const callId = params.callId?.trim();
    let releaseVoice: (() => void) | undefined;
    const release = () => {
      releaseVoice?.();
      if (session.activeAgentRuns.get(params.runId) === params.sessionKey) {
        session.activeAgentRuns.delete(params.runId);
      }
      if (callId && session.activeAgentToolCalls.get(callId) === params.runId) {
        session.activeAgentToolCalls.delete(callId);
      }
    };
    const assertCurrent = () => {
      params.assertCurrent?.();
      if (getRelaySession(params.relaySessionId, params.connId) !== session) {
        throw new Error("Realtime relay session changed during run registration");
      }
      if (
        callId &&
        (session.toolCalls.isAgentCompleted(callId) || session.toolCalls.hasCancelled(callId))
      ) {
        throw new Error("Realtime provider cancelled the tool call before run registration");
      }
    };
    try {
      assertCurrent();
      if (callId && !session.toolCalls.tryAdmit([callId])) {
        throw new Error("Realtime relay tool-call session limit exceeded");
      }
      session.activeAgentRuns.set(params.runId, params.sessionKey);
      if (callId) {
        session.activeAgentToolCalls.set(callId, params.runId);
      }
      if (!(await ensureRelayVoiceSession(session))) {
        throw new Error("Realtime relay voice session could not be created for agent consult");
      }
      assertCurrent();
      const { agentId, sessionKey } = session.sessionTarget;
      releaseVoice = params.registerVoice
        ? await params.registerVoice(assertCurrent)
        : await registerClientVoiceConsultRun({
            agentId,
            sessionKey,
            voiceSessionId: session.id,
            runId: params.runId,
            assertCurrent,
          });
      assertCurrent();
      return release;
    } catch (error) {
      release();
      abortChatRunById(session.context, {
        runId: params.runId,
        sessionKey: params.sessionKey,
        stopReason: "voice session binding failed",
      });
      throw error;
    }
  };
}
