import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import {
  NATIVE_POLICY_ARTIFACT_MARKER,
  type NativePolicySetupPlan,
} from "../browser/native-policy-setup.js";
import { registerBrowserPolicyCommands } from "./browser-cli-policy.js";
import { createBrowserProgram, mockBrowserGateway } from "./browser-cli.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const capture = createCliRuntimeCapture();
const content =
  NATIVE_POLICY_ARTIFACT_MARKER + '{\n  "URLBlocklist": [\n    "example.com"\n  ]\n}\n';
const readyPlan = {
  state: "ready",
  browser: "Google Chrome",
  browserHost: "browser-host",
  executablePath: "/opt/google/chrome/chrome",
  targetPath: "/etc/opt/chrome/policies/managed/openclaw.json",
  scope: "machine",
  operation: "install",
  previousHash: null,
  content,
  contentHash: createHash("sha256").update(content).digest("hex"),
  currentPolicies: {},
} satisfies NativePolicySetupPlan;
let gateway: ReturnType<typeof mockBrowserGateway>;

beforeEach(() => {
  vi.clearAllMocks();
  capture.resetRuntimeCapture();
  gateway = mockBrowserGateway();
  gateway.mockResolvedValue(readyPlan);
  vi.spyOn(defaultRuntime, "log").mockImplementation(capture.defaultRuntime.log);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(capture.defaultRuntime.writeJson);
  vi.spyOn(defaultRuntime, "error").mockImplementation(capture.defaultRuntime.error);
  vi.spyOn(defaultRuntime, "exit").mockImplementation(capture.defaultRuntime.exit);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function run(args: string[]) {
  const { program, browser, parentOpts } = createBrowserProgram({ withGatewayUrl: true });
  registerBrowserPolicyCommands(browser, parentOpts);
  await program.parseAsync(["browser", ...args], { from: "user" });
}

describe("browser policy setup CLI", () => {
  it("returns unsupported host guidance before reading a nonexistent input", async () => {
    gateway.mockResolvedValue({
      state: "unsupported",
      detail: "Use native administrator setup on macOS.",
    });
    await run(["--json", "policy", "setup", "--file", "/nonexistent/native-policy.json", "--yes"]);
    expect(capture.defaultRuntime.writeJson).toHaveBeenCalledWith({
      state: "unsupported",
      detail: "Use native administrator setup on macOS.",
    });
    expect(capture.runtimeErrors).toEqual([]);
  });

  it("exports a private artifact while directing administrator commands to the remote browser host", async () => {
    const dir = tempDirs.make("browser-policy-cli-");
    const input = `${dir}/input.json`;
    const output = `${dir}/export.json`;
    await fs.writeFile(input, '{"URLBlocklist":["example.com"]}');
    await run([
      "--url",
      "wss://gateway.example",
      "--browser-profile",
      "managed",
      "--json",
      "policy",
      "setup",
      "--file",
      input,
      "--output",
      output,
      "--yes",
    ]);
    expect(await fs.readFile(output, "utf8")).toBe(content);
    expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
    expect(gateway.mock.calls.at(-1)?.[1]).toMatchObject({ url: "wss://gateway.example" });
    expect(gateway.mock.calls.at(-1)?.[2]).toMatchObject({
      path: "/policy/setup/plan",
      query: { profile: "managed" },
      body: { operation: "install", policies: { URLBlocklist: ["example.com"] } },
    });
    expect(capture.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "awaiting-operator-action",
        browserHost: "browser-host",
        output,
        exported: true,
        operatorCommand: expect.stringContaining("sudo sh -c"),
        activation: expect.stringContaining("browser host"),
      }),
    );
  });

  it("sanitizes terminal previews without changing the exported native policy", async () => {
    const dir = tempDirs.make("browser-policy-terminal-");
    const input = `${dir}/input.json`;
    const output = `${dir}/export.json`;
    const policies = { URLBlocklist: ["blocked.example\u009b31m"] };
    const nativeContent = NATIVE_POLICY_ARTIFACT_MARKER + JSON.stringify(policies, null, 2) + "\n";
    await fs.writeFile(input, JSON.stringify(policies));
    gateway.mockResolvedValue({
      ...readyPlan,
      content: nativeContent,
      contentHash: createHash("sha256").update(nativeContent).digest("hex"),
    });

    await run(["policy", "setup", "--file", input, "--output", output, "--yes"]);

    expect(await fs.readFile(output, "utf8")).toBe(nativeContent);
    const preview = capture.runtimeLogs.join("\n");
    expect(preview).not.toContain("\u009b");
    expect(preview).toContain("on browser host browser-host");
    expect(preview).toContain("Requested native artifact:\n// OpenClaw");
  });

  it("preserves an existing output instead of replacing user data", async () => {
    const dir = tempDirs.make("browser-policy-existing-");
    const input = `${dir}/input.json`;
    const output = `${dir}/existing.json`;
    await fs.writeFile(input, '{"URLBlocklist":["example.com"]}');
    await fs.writeFile(output, "user data");
    await expect(
      run(["policy", "setup", "--file", input, "--output", output, "--yes"]),
    ).rejects.toThrow();
    expect(await fs.readFile(output, "utf8")).toBe("user data");
    expect(capture.defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it("leaves no artifact without confirmation and reports a prepared plan", async () => {
    const dir = tempDirs.make("browser-policy-preview-");
    const input = `${dir}/input.json`;
    const output = `${dir}/export.json`;
    await fs.writeFile(input, '{"URLBlocklist":["example.com"]}');
    await run(["--json", "policy", "setup", "--file", input, "--output", output]);
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(capture.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ state: "prepared", exported: false }),
    );
  });

  it("verifies fresh native loaded values and current control readiness", async () => {
    const dir = tempDirs.make("browser-policy-verify-");
    const input = `${dir}/input.json`;
    await fs.writeFile(input, '{"URLBlocklist":["example.com"]}');
    gateway.mockImplementation(async (_method, _opts, request) =>
      request.path === "/policy"
        ? {
            state: "effective",
            browser: "Google Chrome",
            version: "144.0.7559.96",
            os: "Linux",
            executablePath: "/opt/google/chrome/chrome",
            observedAt: 1,
            policies: {
              URLBlocklist: {
                value: ["example.com"],
                level: "mandatory",
                scope: "machine",
                source: "platform",
              },
            },
          }
        : { running: true, cdpReady: true },
    );
    await run(["--json", "policy", "verify", "--file", input]);
    expect(capture.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "verified",
        stage: "effective",
        controlReady: true,
        issues: [],
      }),
    );
  });
});
