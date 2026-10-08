import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getSessionControllerOperation,
  captureCurrentReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { resolveActiveSessionRunId } from "../../sessions/session-controller.queries.js";
import {
  isAuthorizedTextSlashCommandTurn,
  isNativeCommandTurn,
  resolveCommandTurnContext,
} from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";

export function parseSteerMessage(raw: string): string | null {
  const match = raw.trim().match(/^\/(?:steer|tell)(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  return (match[1] ?? "").trim();
}

function listSteerCandidateSessionKeys(targetSessionKey: string): string[] {
  const candidates = [targetSessionKey];
  // Authorized text slash turns can still arrive on a source-only :slash:
  // lane while the direct conversation owns the active reply operation.
  if (targetSessionKey.includes(":slash:")) {
    candidates.push(
      targetSessionKey.replace(":slash:", ":direct:"),
      targetSessionKey.replace(":slash:", ":dm:"),
    );
  }
  return candidates;
}

function resolveSteerSourceSessionKey(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  sessionKey?: string;
}): string | undefined {
  const commandTarget = normalizeOptionalString(params.ctx.CommandTargetSessionKey);
  const commandSession = normalizeOptionalString(params.sessionKey ?? params.ctx.SessionKey);
  const raw = isNativeCommandTurn(resolveCommandTurnContext(params.ctx))
    ? commandTarget || commandSession
    : commandSession || commandTarget;
  if (!raw) {
    return undefined;
  }

  const { alias } = resolveMainSessionAlias(params.cfg);
  return resolveInternalSessionKey({ key: raw, alias });
}

// Reads the steer payload of a native or authorized text command turn; null when
// that turn is not the /steer command. Uses the handler's own matcher.
function readExplicitSteerMessage(ctx: MsgContext, commandBody?: string): string | null {
  const commandTurn = resolveCommandTurnContext(ctx);
  if (!isNativeCommandTurn(commandTurn) && !isAuthorizedTextSlashCommandTurn(commandTurn)) {
    return null;
  }
  return parseSteerMessage(
    commandBody ??
      commandTurn.body ??
      normalizeOptionalString(ctx.CommandBody) ??
      normalizeOptionalString(ctx.BodyForCommands) ??
      normalizeOptionalString(ctx.Body) ??
      "",
  );
}

/**
 * True when this turn is an explicit /steer command. Its handler only replies with
 * usage or hands the message to queue policy, so admission must let it reach that
 * policy beside the active turn it steers instead of waiting for that turn to end.
 */
export function isExplicitSteerCommandTurn(ctx: MsgContext): boolean {
  return readExplicitSteerMessage(ctx) !== null;
}

/**
 * Resolve an authorized explicit steer command to the exact session that owns
 * an injectable active reply. This is intentionally read-only: callers decide
 * whether to retarget session preparation or continue as an ordinary prompt.
 */
export function resolveActiveExplicitSteerSessionKey(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  sessionKey?: string;
  commandBody?: string;
}): string | undefined {
  const message = readExplicitSteerMessage(params.ctx, params.commandBody);
  if (!message) {
    return undefined;
  }

  const sourceSessionKey = resolveSteerSourceSessionKey(params);
  if (!sourceSessionKey) {
    return undefined;
  }
  for (const candidateKey of listSteerCandidateSessionKeys(sourceSessionKey)) {
    const operation = getSessionControllerOperation(candidateKey);
    const hasActiveOwner = operation
      ? captureCurrentReplyMessageInjectionTarget(candidateKey) !== undefined
      : resolveActiveSessionRunId(candidateKey) !== undefined;
    if (hasActiveOwner) {
      return candidateKey;
    }
  }
  return undefined;
}
