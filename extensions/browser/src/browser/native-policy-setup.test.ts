import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import * as fileAccess from "openclaw/plugin-sdk/file-access-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_POLICY_ARTIFACT_MARKER,
  nativePolicySetupRequestSchema,
  planNativeBrowserPolicySetup,
  verifyNativeBrowserPolicy,
} from "./native-policy-setup.js";
import type { NativeBrowserPolicyReport } from "./native-policy.js";
import type { ResolvedBrowserProfile } from "./profile.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalPlatform = process.platform;
const profile: ResolvedBrowserProfile = {
  name: "openclaw",
  driver: "openclaw",
  cdpHost: "127.0.0.1",
  cdpIsLoopback: true,
  cdpUrl: "http://127.0.0.1:18800",
  cdpPort: 18800,
  color: "#FF4500",
  headless: true,
  attachOnly: false,
};
const report: Extract<NativeBrowserPolicyReport, { policies: unknown }> = {
  state: "none",
  browser: "Google Chrome",
  version: "144.0.7559.96",
  os: "Linux",
  executablePath: "/opt/google/chrome/chrome",
  policies: {},
  observedAt: 1,
};
const loaded = { level: "mandatory", scope: "machine", source: "platform" };

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("native policy setup", () => {
  it.each([
    {
      browser: "Google Chrome",
      executablePath: "/opt/google/chrome/google-chrome",
      targetPath: "/etc/opt/chrome/policies/managed/openclaw.json",
    },
    {
      browser: "Chromium",
      executablePath: "/usr/local/share/chromium/chrome-linux/chrome",
      targetPath: "/etc/chromium/policies/managed/openclaw.json",
    },
  ])(
    "selects the fixed machine path for the verified $browser deployment",
    async ({ browser, executablePath, targetPath }) => {
      vi.spyOn(fs, "lstat").mockRejectedValue(
        Object.assign(new Error("missing"), { code: "ENOENT" }),
      );
      const plan = await planNativeBrowserPolicySetup({
        report: { ...report, browser, executablePath },
        profile,
        request: { operation: "install", policies: { URLBlocklist: ["example.com"] } },
      });
      expect(plan).toMatchObject({
        state: "ready",
        operation: "install",
        targetPath,
        previousHash: null,
        scope: "machine",
      });
      if (plan.state !== "ready" || !plan.content) {
        throw new Error("Expected native artifact");
      }
      expect(JSON.parse(plan.content.slice(NATIVE_POLICY_ARTIFACT_MARKER.length))).toEqual({
        URLBlocklist: ["example.com"],
      });
    },
  );

  it.each([
    { profile: { ...profile, attachOnly: true }, report },
    { profile: { ...profile, cdpIsLoopback: false, cdpHost: "remote.example" }, report },
    { profile, report: { ...report, browser: "Browser derivative" } },
    { profile, report: { ...report, os: "Windows" } },
    { profile, report: { ...report, executablePath: "/odd/chrome" } },
    {
      profile,
      report: { ...report, browser: "Chromium", executablePath: "/snap/chromium/123/chrome" },
    },
    { profile, report: { ...report, browser: "Chromium", executablePath: "/app/chromium/chrome" } },
  ])("does not inspect host files for an unsupported browser ownership", async (entry) => {
    const read = vi.spyOn(fs, "lstat");
    expect(
      await planNativeBrowserPolicySetup({ ...entry, request: { operation: "inspect" } }),
    ).toMatchObject({ state: "unsupported" });
    expect(read).not.toHaveBeenCalled();
  });

  it("protects foreign native files and records the owned artifact hash for guarded updates", async () => {
    const dir = tempDirs.make("native-policy-artifact-");
    const file = `${dir}/artifact.json`;
    await fs.writeFile(file, '{"URLBlocklist":["administrator.example"]}');
    const foreignStat = await fs.lstat(file);
    vi.spyOn(fs, "lstat").mockResolvedValue(foreignStat);
    const foreign = await fileAccess.readRegularFile({ filePath: file });
    const reader = vi.spyOn(fileAccess, "readRegularFile").mockResolvedValue(foreign);
    expect(
      await planNativeBrowserPolicySetup({
        report,
        profile,
        request: { operation: "install", policies: { URLBlocklist: ["example.com"] } },
      }),
    ).toMatchObject({ state: "blocked", detail: expect.stringContaining("another operator") });
    const own = NATIVE_POLICY_ARTIFACT_MARKER + '{"URLBlocklist":["example.com"]}\n';
    reader.mockResolvedValue({ buffer: Buffer.from(own), stat: foreignStat });
    expect(
      await planNativeBrowserPolicySetup({ report, profile, request: { operation: "remove" } }),
    ).toMatchObject({
      state: "ready",
      operation: "remove",
      previousHash: createHash("sha256").update(own).digest("hex"),
      content: null,
    });
  });

  it("refuses symlinked policy ownership instead of following the target", async () => {
    const dir = tempDirs.make("native-policy-link-");
    await fs.symlink("missing", `${dir}/link`);
    const linkStat = await fs.lstat(`${dir}/link`);
    vi.spyOn(fs, "lstat").mockResolvedValue(linkStat);
    expect(
      await planNativeBrowserPolicySetup({ report, profile, request: { operation: "remove" } }),
    ).toMatchObject({ state: "blocked" });
  });

  it("bounds supplied native JSON before serializing an artifact", () => {
    expect(
      nativePolicySetupRequestSchema.safeParse({
        operation: "install",
        policies: { URLBlocklist: ["x".repeat(64 * 1024)] },
      }).success,
    ).toBe(false);
  });
});

describe("native policy verification", () => {
  it("confirms native dictionary and immediate dictionary-list display serialization", () => {
    const policies = {
      ProxySettings: { ProxyMode: "direct" },
      ManagedBookmarks: [{ name: "Example", url: "https://example.com" }],
    };
    expect(
      verifyNativeBrowserPolicy({
        policies,
        controlReady: true,
        report: {
          ...report,
          state: "effective",
          policies: {
            ProxySettings: { ...loaded, value: '{ "ProxyMode": "direct" }' },
            ManagedBookmarks: {
              ...loaded,
              value: ['{ "name": "Example", "url": "https://example.com" }'],
            },
          },
        },
      }),
    ).toMatchObject({ state: "verified", issues: [] });
  });

  it.each([
    { error: "Invalid policy value" },
    { ignored: true },
    { future: true },
    { restartRequired: true },
    { source: "cloud" },
    { level: "recommended" },
    { scope: "user" },
    { value: ["different.example"] },
  ])("does not confirm a native unusable or overriding policy %j", (diagnostic) => {
    expect(
      verifyNativeBrowserPolicy({
        policies: { URLBlocklist: ["example.com"] },
        controlReady: true,
        report: {
          ...report,
          state: "effective",
          policies: { URLBlocklist: { ...loaded, value: ["example.com"], ...diagnostic } },
        },
      }),
    ).toMatchObject({
      state: "unverified",
      issues: expect.arrayContaining([expect.objectContaining({ policy: "URLBlocklist" })]),
    });
  });

  it("does not confirm masked values or unavailable browser control", () => {
    expect(
      verifyNativeBrowserPolicy({
        policies: { ProxySettings: { Password: "private" } },
        controlReady: true,
        report: {
          ...report,
          policies: { ProxySettings: { ...loaded, value: '{"Password":"********"}' } },
        },
      }).state,
    ).toBe("unverified");
    expect(
      verifyNativeBrowserPolicy({
        policies: { RemoteDebuggingAllowed: false },
        controlReady: false,
        report: { ...report, policies: { RemoteDebuggingAllowed: { ...loaded, value: false } } },
      }),
    ).toMatchObject({ state: "unverified", controlReady: false });
  });
});
