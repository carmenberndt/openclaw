---
summary: "Separating CDP startup failures from page navigation failures, plus the platform-specific pages"
title: "Browser troubleshooting"
read_when:
  - The browser will not start or a page will not load
  - You need to tell a CDP readiness failure from a policy block
---

For Linux-specific issues (especially snap Chromium), see
[Browser troubleshooting](/tools/browser-linux-troubleshooting).

For WSL2 Gateway + Windows Chrome split-host setups, see
[WSL2 + Windows + remote Chrome CDP troubleshooting](/tools/browser-wsl2-windows-remote-cdp-troubleshooting).

## Inspection times out but screenshots work

Snapshots and page-text reads use a browser automation connection that can become
stale even while tab listing and screenshots still work. OpenClaw reconnects once
when that connection can no longer resolve the requested tab. Unresponsive sibling
tabs share one target-inspection wait instead of adding a separate wait per tab.

Retry the inspection once with the same profile and target ID. If it still fails,
run `openclaw browser doctor` and inspect a screenshot before restarting the
Gateway. A browser-rendered HTTP error, such as `403 Forbidden`, is evidence that
the website denied access; it does not establish whether a profile or resource
exists.

## Output directory errors

If an output fails with `Invalid path: must stay within output directory`, set
the output directory to its real, canonical path. Browser outputs reject
user-created symlinks anywhere in the directory path, including when the final
directory already exists. The macOS `/tmp` and `/var` system aliases remain
supported.

<a id="cdp-startup-failure-vs-navigation-ssrf-block" />

## CDP startup failure vs page navigation failure

These are different failure classes and they point to different code paths.

- **CDP startup or readiness failure** means OpenClaw cannot confirm that the browser control plane is healthy.
- **Page navigation failure** means control is available, but the URL is invalid or the browser cannot load the target page.

Common examples:

- CDP startup or readiness failure:
  - `Chrome CDP websocket for profile "openclaw" is not reachable after start`
  - `Remote CDP for profile "<name>" is not reachable at <cdpUrl>`
  - `Port <port> is in use for profile "<name>" but not by openclaw` when a
    loopback external CDP service is configured without `attachOnly: true`
- Page navigation failure:
  - `open` or `navigate` rejects an unsupported scheme or URL-embedded credentials
  - the browser reports a connection, TLS, or website error while `start` and `tabs` still work

Use this minimal sequence to separate the two:

```bash
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw tabs
openclaw browser --browser-profile openclaw open https://example.com
```

How to read the results:

- If `start` fails with `not reachable after start`, troubleshoot CDP readiness first.
- If `start` succeeds but `tabs` fails, the control plane is still unhealthy. Treat this as a CDP reachability problem, not a page-navigation problem.
- If `start` and `tabs` succeed but `open` or `navigate` fails, the browser control plane is up. Check the requested URL and the target page.
- If `start`, `tabs`, and `open` all succeed, the basic managed-browser control path is healthy.

Important behavior details:

- `browser.cdpPolicy` defaults to strict checks for remote control endpoints; it does not restrict page destinations.
- For the local loopback `openclaw` managed profile, CDP health checks intentionally skip remote CDP endpoint enforcement for OpenClaw's own local control plane.
- After launching a local managed browser, readiness checks allow up to 1.5 seconds per HTTP request and 2 seconds per WebSocket stage to tolerate Gateway scheduling delays. The readiness retry window is eight seconds; checks near its end use shorter timeouts.
- Later operations use the same readiness allowance for an owned managed browser before deciding it needs a restart. Stopping a profile aborts its pending discovery and readiness checks; canceling one caller waiting for a shared start does not stop that shared launch.
- Page navigation has no OpenClaw IP/DNS guard. HTTP(S) localhost and private pages use ordinary browser behavior; native browser security stays enabled.

Resetting or deleting a local managed profile stops a verified browser left by an
earlier Gateway runtime before moving its data. If a live profile owner cannot be
verified or stopped, OpenClaw preserves the profile data and reports the reason.
Close the browser using that profile and check its Chromium lock before retrying.
Locks naming another hostname remain unverified, including after a machine rename;
starting the browser also preserves that locked profile's preferences.

Security guidance:

- Keep CDP endpoint restrictions unless you need a trusted remote control endpoint.
- Prefer narrow exact-hostname `browser.cdpPolicy.allowedHostnames` exceptions over broad private-network access.
- Use `browser.cdpPolicy.dangerouslyAllowPrivateNetwork: true` only in intentionally trusted environments where private-network CDP access is required.
- To restrict browser page egress, use host/container isolation or a policy-enforcing proxy; `browser.cdpPolicy` does not provide that boundary.
