import { randomUUID } from "node:crypto";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { resolveStateDir } from "../config/state-dir.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { withClientVoiceSessionSettlement } from "./client-voice-session-lifecycle.js";
import type { ClientVoiceSessionRecord } from "./client-voice-session-store.js";
import type { VoiceSessionMutation } from "./client-voice-session-write.kernel.js";

/** Voice metadata keeps its durable agent owner, including for incognito transcripts. */
export function captureClientVoiceSessionWriter(params: {
  agentId: string;
  assertCurrent?: () => void;
}) {
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = {
    agentId: params.agentId,
    env,
    path: resolveOpenClawAgentSqlitePath({ agentId: params.agentId, env }),
  };
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const assertCurrent = () => {
    execution.assertCurrent();
    params.assertCurrent?.();
  };
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertCurrent();
          if (!grant()) {
            throw new Error("Voice session write authority expired");
          }
        }, binding.attachment),
      });
    },
  };
  function mutate(input: VoiceSessionMutation): Promise<ClientVoiceSessionRecord | undefined>;
  function mutate<T>(
    input: VoiceSessionMutation,
    publish: (record: ClientVoiceSessionRecord | undefined, entry?: InternalSessionEntry) => T,
  ): Promise<T>;
  async function mutate<T>(
    input: VoiceSessionMutation,
    publish?: (record: ClientVoiceSessionRecord | undefined, entry?: InternalSessionEntry) => T,
  ): Promise<T | ClientVoiceSessionRecord | undefined> {
    const captured = structuredClone(input);
    return runOpenClawAgentWorkerWrite(options, async () => {
      if (captured.kind === "create") {
        await execution.prepare(source);
      }
      const result = await execution.runExisting(source, async (worker) => {
        const committed = await worker.execute({ type: "voice.session.mutate", input: captured });
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
    assertCurrent,
    release: () => execution.release(),
    read(voiceSessionId: string) {
      return runOpenClawAgentWorkerWrite(options, () =>
        execution.runExisting(source, async (worker) => {
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

/** Create a call record or resume the same open call across transport restarts. */
export async function createOrResumeClientVoiceSession(input: {
  agentId: string;
  sessionKey: string;
  provider?: string;
  origin: "client" | "relay";
  transcriptCapable?: boolean;
  voiceSessionId?: string;
  now?: number;
  assertCurrent?: () => void;
}): Promise<string> {
  const params = { ...input };
  return withClientVoiceSessionSettlement(async () => {
    const voiceSessionId = params.voiceSessionId?.trim() || randomUUID();
    const writer = captureClientVoiceSessionWriter(params);
    try {
      await writer.mutate({
        kind: "create",
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        voiceSessionId,
        provider: params.provider?.trim() || undefined,
        origin: params.origin,
        transcriptCapable: params.transcriptCapable,
        now: params.now ?? Date.now(),
      });
      return voiceSessionId;
    } finally {
      await writer.release();
    }
  });
}
