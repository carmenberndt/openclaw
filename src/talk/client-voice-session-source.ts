import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import {
  assertDatabasePathIdentity,
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
