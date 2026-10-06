// Bundled runtime authority for selected sessions and conversation bindings.
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";

export { captureSessionEntryCurrentCheck } from "../config/sessions/session-entry-current-check.js";

/** Preserve prepared entry sources while adding short, non-entry-SQL live checks. */
export const composeSessionEntryCommitGuards: (
  sources: readonly ((() => void) | undefined)[],
  check?: (assertSources: () => void) => void,
) => () => void = composeSessionSourceAssertion;

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
