import { describe, expect, it } from "vitest";
import {
  nativePolicyAvailability,
  parseNativePolicyValues,
  summarizeNativePolicy,
} from "./native-policy.js";
import type { ResolvedBrowserProfile } from "./profile.types.js";

const identity = {
  browser: "Google Chrome",
  version: "144.0.7559.96",
  os: "Linux",
  executablePath: "/opt/google/chrome/chrome",
};
const profile: ResolvedBrowserProfile = {
  name: "openclaw",
  cdpPort: 18800,
  cdpUrl: "http://127.0.0.1:18800",
  cdpHost: "127.0.0.1",
  cdpIsLoopback: true,
  driver: "openclaw",
  color: "#FF4500",
  headless: true,
  attachOnly: false,
};

describe("native policy inspection", () => {
  it("distinguishes a browser-confirmed empty policy from unverified status", () => {
    // Chrome 144's policies-updated event contains an empty chrome policy group
    // even when no policy file exists; a missing group must never mean no policy.
    expect(
      parseNativePolicyValues(identity, {
        policyIds: ["chrome"],
        policyValues: { chrome: { name: "Chrome Policies", policies: {} } },
      }),
    ).toMatchObject({ state: "none", ...identity, policies: {} });
    expect(nativePolicyAvailability(profile)).toMatchObject({ state: "unverified" });
    expect(() => parseNativePolicyValues(identity, { policyValues: {} })).toThrow("unsupported");
  });

  it("preserves native provider diagnostics and precedence without reinterpreting rules", () => {
    const policy = {
      value: ["*"],
      level: "mandatory",
      scope: "machine",
      source: "platform",
      warning: "conflicting policy",
      conflicts: [{ value: ["example.com"], source: "cloud" }],
    };
    expect(
      parseNativePolicyValues(identity, {
        policyValues: { chrome: { policies: { URLBlocklist: policy } } },
      }),
    ).toMatchObject({ state: "effective", policies: { URLBlocklist: policy } });
  });

  it("does not advertise another engine or transport as Chromium policy support", () => {
    expect(nativePolicyAvailability({ ...profile, engine: "lightpanda" }).state).toBe(
      "unsupported",
    );
    expect(nativePolicyAvailability({ ...profile, driver: "existing-session" }).state).toBe(
      "unsupported",
    );
    expect(nativePolicyAvailability({ ...profile, driver: "extension" }).state).toBe("unsupported");
    expect(
      parseNativePolicyValues(
        { ...identity, browser: "Unverified Browser" },
        { policyValues: { chrome: { policies: {} } } },
      ).state,
    ).toBe("unsupported");
    expect(
      parseNativePolicyValues(
        { ...identity, os: "Mac OS X" },
        { policyValues: { chrome: { policies: {} } } },
      ).state,
    ).toBe("unsupported");
  });

  it("keeps raw enterprise values out of model-visible doctor summaries", () => {
    const report = parseNativePolicyValues(identity, {
      policyValues: {
        chrome: {
          policies: {
            HomepageLocation: {
              value: "https://private.example",
              level: "mandatory",
              scope: "machine",
              source: "platform",
            },
          },
        },
      },
    });
    expect(summarizeNativePolicy(report)).toEqual({
      state: "effective",
      detail: "Google Chrome: 1 loaded policy entries; browser owns validation and enforcement",
    });
    expect(JSON.stringify(summarizeNativePolicy(report))).not.toContain("private.example");
  });
});
