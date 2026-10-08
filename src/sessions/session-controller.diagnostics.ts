import { diagnosticLogger } from "../logging/diagnostic-runtime.js";
import { isMutationOwnedTurn } from "./session-controller.admission-rule.js";
import type { SessionControllerInput } from "./session-controller.mailbox.types.js";

type ControllerPhase =
  | "source-claim"
  | "injection-predecessor"
  | "injection-outcome"
  | "successor-barrier"
  | "followup-barrier"
  | "lifecycle-admission"
  | "recovery-predecessor";

type ControllerPhaseStatus =
  | "waiting"
  | "selected"
  | "settled"
  | "failed"
  | "reserved"
  | "restored";

/** Captures one phase identity while callers record its synchronous transitions. */
export function createSessionControllerPhaseLogger(
  phase: ControllerPhase,
  identity: { sessionKey: string; sessionId?: string; sourceId?: string },
): (status: ControllerPhaseStatus, reason?: string) => void {
  return (status, reason) => logSessionControllerPhase({ ...identity, phase, status, reason });
}

/** Records bounded wait transitions without refreshing liveness or changing custody. */
export function logSessionControllerPhase(params: {
  phase: ControllerPhase;
  status: ControllerPhaseStatus;
  sessionKey: string;
  sessionId?: string;
  sourceId?: string;
  reason?: string;
  pendingInputs?: number;
  injectingInputs?: number;
  withdrawalHolds?: number;
  prioritySourceId?: string;
}): void {
  if (!diagnosticLogger.isEnabled("info")) {
    return;
  }
  // Identity fields are bounded and omit payloads, paths, authority, and error contents.
  const bounded = (value: string | undefined) => value?.slice(0, 120);
  diagnosticLogger.info("session controller phase", {
    ...params,
    sessionKey: bounded(params.sessionKey),
    sessionId: bounded(params.sessionId),
    sourceId: bounded(params.sourceId),
    reason: bounded(params.reason),
    prioritySourceId: bounded(params.prioritySourceId),
  });
}

/** Captures the selector's current blockers once per source claim transition. */
export function logSessionControllerSourceClaim(
  input: SessionControllerInput,
  status: "waiting" | "selected" | "failed",
): void {
  if (!diagnosticLogger.isEnabled("info")) {
    return;
  }
  const { mailbox } = input;
  logSessionControllerPhase({
    phase: "source-claim",
    status,
    sessionKey: mailbox.key,
    sessionId: input.sourceSessionId,
    sourceId: input.protocolRunId ?? input.instance.id,
    reason: mailbox.owner.successorBarrier
      ? "successor-barrier"
      : mailbox.owner.followupBarrier
        ? "followup-barrier"
        : mailbox.claim
          ? "claim-owned"
          : mailbox.owner.active
            ? "operation-owned"
            : mailbox.owner.lifecycle?.blocksTurnAdmission &&
                !isMutationOwnedTurn(mailbox.owner, input)
              ? "lifecycle-blocked"
              : "mailbox-selection",
    pendingInputs: mailbox.entries.length,
    injectingInputs: mailbox.entries.filter((entry) => entry.injection).length,
    withdrawalHolds: input.withdrawalHolds,
    prioritySourceId: mailbox.priority?.instance.id,
  });
}
