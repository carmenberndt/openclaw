import {
  ensureRecord,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";
import { normalizeHostname } from "../../../infra/net/hostname.js";

export const LEGACY_CONFIG_MIGRATION_RUNTIME_BROWSER: LegacyConfigMigrationSpec = {
  id: "browser.ssrf-policy->cdp-policy",
  legacyRules: [
    {
      path: ["browser", "ssrfPolicy"],
      message:
        'browser.ssrfPolicy is retired: browser page navigation no longer performs private-IP or DNS security checks, including explicit strict settings. CDP endpoint restrictions move to browser.cdpPolicy; private image endpoint permission uses models.providers.openai.request.allowPrivateNetwork. Native browser security remains enabled. Run "openclaw doctor --fix".',
    },
  ],
  apply: (raw, changes) => {
    const browser = getRecord(raw.browser);
    if (!browser || !Object.hasOwn(browser, "ssrfPolicy")) {
      return;
    }
    const legacy = getRecord(browser.ssrfPolicy);
    if (legacy) {
      const policy = { ...legacy };
      if (Object.hasOwn(policy, "allowPrivateNetwork")) {
        // Either old spelling enabled private control access; preserve that
        // effective value before letting authored canonical CDP fields win.
        const oldValue = policy.allowPrivateNetwork;
        const currentValue = policy.dangerouslyAllowPrivateNetwork;
        policy.dangerouslyAllowPrivateNetwork =
          typeof oldValue === "boolean" || typeof currentValue === "boolean"
            ? oldValue === true || currentValue === true
            : (currentValue ?? oldValue);
        delete policy.allowPrivateNetwork;
      }
      if (Array.isArray(policy.hostnameAllowlist)) {
        const allowed = Array.isArray(policy.allowedHostnames) ? policy.allowedHostnames : [];
        policy.allowedHostnames = [
          ...new Set(
            [...allowed, ...policy.hostnameAllowlist].filter((value) => typeof value === "string"),
          ),
        ];
        delete policy.hostnameAllowlist;
      }
      if (policy.dangerouslyAllowPrivateNetwork === true) {
        const openai = getRecord(getRecord(getRecord(raw.models)?.providers)?.openai);
        const request = getRecord(openai?.request);
        const endpoint =
          typeof openai?.baseUrl === "string" ? URL.parse(openai.baseUrl.trim()) : null;
        const customEndpoint =
          endpoint &&
          !["api.openai.com", "chatgpt.com"].includes(normalizeHostname(endpoint.hostname));
        // An environment API key already selects native auth for custom endpoints.
        // Adding request settings without that fact can instead displace OAuth.
        const directRoute =
          openai &&
          (request ||
            (customEndpoint &&
              openai.api !== "openai-chatgpt-responses" &&
              Boolean(process.env.OPENAI_API_KEY?.trim())) ||
            openai.apiKey !== undefined ||
            openai.auth === "api-key" ||
            openai.headers !== undefined ||
            openai.authHeader !== undefined ||
            (openai.api !== undefined && openai.api !== "openai-chatgpt-responses"));
        if (openai && directRoute) {
          const imageRequest = request ?? ensureRecord(openai, "request");
          if (imageRequest.allowPrivateNetwork === undefined) {
            imageRequest.allowPrivateNetwork = true;
            changes.push(
              "Preserved private image endpoint permission in models.providers.openai.request.allowPrivateNetwork.",
            );
          }
        } else {
          changes.push(
            "Private image endpoint permission now uses models.providers.openai.request.allowPrivateNetwork; configure it explicitly if needed. No provider request settings were added to avoid changing image auth routing.",
          );
        }
      }
      const canonical = getRecord(browser.cdpPolicy);
      if (browser.cdpPolicy === undefined || canonical) {
        browser.cdpPolicy = { ...policy, ...canonical };
      }
    }
    delete browser.ssrfPolicy;
    changes.push(
      "Removed browser.ssrfPolicy; CDP endpoint settings are preserved in browser.cdpPolicy (existing fields win). Browser page navigation no longer performs private-IP or DNS security checks, including explicit strict settings. Private image endpoint permission uses models.providers.openai.request.allowPrivateNetwork. Discord attachment downloads use Discord-owned CDN and configured-endpoint rules; old browser policy overrides no longer apply to them. Native browser security remains enabled.",
    );
  },
};
