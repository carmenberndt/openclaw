/**
 * Endpoint policy adjustments for Chrome DevTools Protocol reachability checks.
 * Configured local control endpoints remain reachable under strict CDP policy.
 */
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import { normalizeHostname } from "openclaw/plugin-sdk/security-runtime";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserProfileUnavailableError } from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import {
  isCdpHostnameBlockedByPolicy,
  isCdpHostnameTrustedByPolicy,
  withExactHostnamePolicy,
} from "./ssrf-policy-helpers.js";

// Synthetic exact-host CDP policies must retain the operator's original intent;
// otherwise Chrome MCP cannot distinguish default control-plane scoping from a
// user-authored restriction that genuinely requires pinned transport.
const cdpControlSourcePolicyByScopedPolicy = new WeakMap<SsrFPolicy, SsrFPolicy>();

function withCdpControlHostname(
  profile: ResolvedBrowserProfile,
  cdpPolicy?: SsrFPolicy,
  requireTrustedHostname = false,
): SsrFPolicy | undefined {
  const cdpHost = normalizeHostname(profile.cdpHost);
  if (!cdpPolicy || !cdpHost) {
    return cdpPolicy;
  }
  if (requireTrustedHostname && !isCdpHostnameTrustedByPolicy(cdpPolicy, cdpHost)) {
    return cdpPolicy;
  }
  const scopedPolicy = withExactHostnamePolicy(cdpPolicy, cdpHost);
  cdpControlSourcePolicyByScopedPolicy.set(scopedPolicy, cdpPolicy);
  return scopedPolicy;
}

function hasPolicyEntries(values?: string[]): boolean {
  return (values ?? []).some((value) => value.trim().length > 0);
}

function requiresPinnedChromeMcpCdpTransport(
  cdpPolicy: SsrFPolicy | undefined,
  cdpHost: string,
): boolean {
  if (!cdpPolicy) {
    return false;
  }
  const policyIntent = cdpControlSourcePolicyByScopedPolicy.get(cdpPolicy) ?? cdpPolicy;
  // A blocklist only restricts this endpoint when its own host is denied;
  // unrelated denials must not disable a trusted explicit CDP endpoint.
  const hasScopedPolicy =
    policyIntent.allowRfc2544BenchmarkRange === true ||
    policyIntent.allowIpv6UniqueLocalRange === true ||
    hasPolicyEntries(policyIntent.allowedHostnames) ||
    hasPolicyEntries(policyIntent.hostnameAllowlist) ||
    isCdpHostnameBlockedByPolicy(policyIntent, cdpHost) ||
    hasPolicyEntries(policyIntent.allowedOrigins);
  return !(
    !hasScopedPolicy &&
    (policyIntent.dangerouslyAllowPrivateNetwork === true ||
      policyIntent.allowPrivateNetwork === true)
  );
}

export function resolveCdpReachabilityPolicy(
  profile: ResolvedBrowserProfile,
  cdpPolicy?: SsrFPolicy,
): SsrFPolicy | undefined {
  const capabilities = getBrowserProfileCapabilities(profile);
  // Local managed CDP is owned by OpenClaw; strict remote endpoint policy
  // must not block its loopback health and control checks.
  if (!capabilities.isRemote && profile.cdpIsLoopback && profile.driver === "openclaw") {
    return undefined;
  }
  // Scope configured local relays to their exact host. Remote CDP hosts must
  // satisfy the configured trust policy before their control policy is narrowed.
  return withCdpControlHostname(profile, cdpPolicy, capabilities.isRemote);
}

/** Alias used by callers that treat reachability and control as one CDP policy. */
export const resolveCdpControlPolicy = resolveCdpReachabilityPolicy;

export function assertChromeMcpCdpTransportAllowed(
  profile: ResolvedBrowserProfile,
  cdpPolicy?: SsrFPolicy,
): void {
  if (profile.driver !== "existing-session" || !profile.cdpUrl) {
    return;
  }
  if (!requiresPinnedChromeMcpCdpTransport(cdpPolicy, profile.cdpHost)) {
    return;
  }
  throw new BrowserProfileUnavailableError(
    `Browser profile "${profile.name}" uses Chrome MCP with an explicit CDP endpoint, but the active Browser CDP policy requires OpenClaw to pin the approved endpoint. Chrome MCP cannot carry that pinned transport across its subprocess boundary. Use driver "openclaw" for guarded CDP endpoints, or remove cdpUrl and browserUrl/wsEndpoint mcpArgs from this existing-session profile so Chrome MCP attaches to a host-local Chrome profile.`,
  );
}
