---
summary: "What giving the model a real browser exposes, and the policy protecting CDP endpoints"
read_when:
  - Enabling browser control or the Chrome extension relay
  - Deciding which browser profile an agent may drive
  - Tuning CDP endpoint allow and block lists
title: "Browser control risks"
sidebarTitle: "Browser control"
---

## Browser control risks

Enabling browser control gives the model a real browser. If that profile already has logged-in sessions, the model can access those accounts and data - treat browser profiles as sensitive state.

- Prefer a dedicated profile for the agent (the default `openclaw` profile); avoid your personal daily-driver profile.
- Keep host browser control disabled for sandboxed agents unless you trust them.
- The standalone loopback browser control API only honors shared-secret auth (gateway token bearer auth or gateway password) - it does not consume trusted-proxy or Tailscale Serve identity headers.
- Treat browser downloads as untrusted input; prefer an isolated downloads directory.
- Disable browser sync/password managers in the agent profile if possible.
- For remote gateways, "browser control" is equivalent to "operator access" to whatever that profile can reach.
- Keep Gateway and node hosts tailnet-only; avoid exposing browser control ports to LAN or public internet.
- Disable browser proxy routing when not needed (`gateway.nodes.browser.mode="off"`).
- Chrome MCP existing-session mode is not "safer" - it can act as you in whatever that host Chrome profile can reach.
- Browser Relay Authentication v2 never sends the persistent extension relay
  key. The extension and external CDP clients verify a signed server challenge
  before returning a short-lived, one-time, connection-bound HMAC proof. Proofs
  bind the protocol version, role, transport, method, resource, flow, profile,
  and relay instance; replay on the same or another socket fails.
- `browser.extensionRelay.allowLegacyAuth` defaults to `true` for one migration
  window. This temporarily accepts old Bearer, Basic, and token-subprotocol
  relay clients. Update every relay client, then set it to `false`. V2 clients
  never downgrade after a failed proof or unsupported response.
- Chrome extension pairing stores its access mode in extension-owned Chrome
  storage, not Gateway config. **All tabs** exposes every eligible ordinary tab
  in that Chrome profile except session-paused tabs; **Selected tabs** uses the
  OpenClaw tab group as its ACL. Existing pairings migrate to **Selected tabs**,
  while new personal-browser pairings recommend **All tabs**. Incognito and
  internal Chrome pages remain excluded in either mode.
- Automatic Chrome extension setup uses an origin-locked native messaging
  manifest discovered from an exact unpacked extension path in Chrome profile
  metadata. The one-shot host accepts only a versioned request with a fresh
  nonce, caps input at 4 KiB, validates the Chrome-supplied origin, and returns
  only a locally owned pairing. It never transfers a remote Gateway key.
- Native-host manifests, launchers, and status output contain no pairing key.
  OpenClaw refuses symlinks, unsafe ownership/modes, wildcard origins, and
  foreign registrations using the same host name. Windows uses the manual
  pairing fallback until an executable native-host path is supported.
- Run a **node host** on the browser machine and let the Gateway proxy browser actions when the Gateway is remote from the browser (see [Browser tool](/tools/browser)); treat node pairing like admin access, keep Gateway and node host on the same tailnet, and avoid exposing relay/control ports over LAN, public internet, or Tailscale Funnel.

<a id="browser-ssrf-policy-(strict-by-default)" />
<a id="browser-ssrf-policy-strict-by-default" />

### Page navigation and CDP endpoint policy

Browser pages can reach the networks available to the browser process, including
localhost and private addresses. OpenClaw does not add IP/DNS preflight checks,
request interception, or final-URL quarantine. Chromium's native security stays
enabled. Use host/container network isolation or a policy-enforcing proxy when
an agent's browser must have restricted egress.

Explicit `open` and `navigate` URLs accept HTTP, HTTPS, and `about:blank`.
OpenClaw rejects malformed URLs, unsupported schemes, and embedded credentials
before dispatch. Use `openclaw browser set credentials <username> <password>`
for HTTP Basic auth or an authenticated browser profile.

`browser.cdpPolicy` protects CDP discovery and control sockets only:

- Private/internal/special-use remote CDP destinations are blocked by default.
  Set `dangerouslyAllowPrivateNetwork: true` only for trusted CDP endpoints.
- `allowedHostnames` grants exact-host exceptions without trusting the entire
  private network.
- `blockedHostnames` denies exact hosts and wildcard subdomains before DNS and
  allow rules. `*.example.com` excludes the apex; add `example.com` to deny both.
- Range allowances apply to trusted fake-IP CDP endpoints, not page traffic.
- OpenClaw's own local managed Chrome control endpoint is exempt from remote
  endpoint restrictions.

```json5
{
  browser: {
    cdpPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["browser-control.example.com"],
      blockedHostnames: ["untrusted-control.example.com"],
    },
  },
}
```

`browser.ssrfPolicy` is retired. `openclaw doctor --fix` preserves its CDP settings
in `browser.cdpPolicy` and visibly reports that page IP/DNS protection was removed,
including explicit strict settings. See [Browser configuration](/tools/browser/configuration#cdp-endpoint-policy)
for transport restrictions and [Config migrations](/gateway/doctor/config-migrations)
for merge behavior. Guarded HTTP fetches keep their own SSRF policy; for example,
`tools.web.fetch.ssrfPolicy.blockedHostnames` still applies to web fetch redirects.
