// Bundled runtime authority for selected sessions and conversation bindings.
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";

export { captureSessionEntryCurrentCheck } from "../config/sessions/session-entry-current-check.js";

/** Compose prepared sources; opaque callbacks retain their native transaction visibility. */
export function composeSessionEntryCommitGuards(
  sources: readonly ((() => void) | undefined)[],
  check?: (assertSources: () => void) => void,
): () => void {
  return composeSessionSourceAssertion(sources.map(captureExternalSessionCommitGuard), check);
}

export {
  testing as __testing,
  testing,
  getSessionBindingService,
  inspectSessionBindingByConversation,
  registerSessionBindingAdapter,
  type SessionBindingRecord,
  type SessionBindingService,
  type AsyncSessionBindingService,
} from "../infra/outbound/session-binding-service.js";
