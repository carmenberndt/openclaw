import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { VerifiedGitUpdateReceipt } from "./restart-sentinel.js";
import { resolveStartupInstallStatus, withUpdateInstallStatus } from "./update-install-status.js";

const mocks = vi.hoisted(() => ({
  root: vi.fn<() => Promise<string>>(),
  receipt: vi.fn<() => Promise<VerifiedGitUpdateReceipt | null>>(),
}));
vi.mock("./openclaw-root.js", async (original) => ({
  ...(await original<typeof import("./openclaw-root.js")>()),
  resolveOpenClawPackageRoot: mocks.root,
}));
// mock-isolation: Exercise Git discovery independently of the receipt database worker.
vi.mock("./restart-sentinel.js", () => ({ readVerifiedGitUpdateReceipt: mocks.receipt }));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.resetAllMocks());

async function git(root: string, ...args: string[]) {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], { timeoutMs: 5000 });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

it("keeps detached Dev discovery independent of receipt state", async () => {
  const base = await fs.realpath(dirs.make("openclaw-receipt-independent-"));
  const source = path.join(base, "source");
  const root = path.join(base, "install");
  await fs.mkdir(source);
  await git(source, "init", "--initial-branch=main");
  await git(source, "config", "user.name", "OpenClaw Test");
  await git(source, "config", "user.email", "test@openclaw.invalid");
  await git(source, "config", "commit.gpgsign", "false");
  await git(source, "commit", "--allow-empty", "-m", "installed");
  const sha = await git(source, "rev-parse", "HEAD");
  await git(source, "branch", "old-stream");
  await git(source, "commit", "--allow-empty", "-m", "available");
  const target = await git(source, "rev-parse", "HEAD");
  await git(base, "clone", "--quiet", source, root);
  await git(root, "checkout", "--detach", sha);
  await git(root, "branch", "--unset-upstream", "main");
  const config = await fs.readFile(path.join(root, ".git", "config"), "utf8");
  mocks.root.mockResolvedValue(root);
  const matching = { root, sha, upstreamRef: "origin/main", installedAtMs: 1234 };
  const receipts = [
    { name: "absent", receipt: null },
    { name: "matching", receipt: matching },
    { name: "different stream", receipt: { ...matching, upstreamRef: "origin/old-stream" } },
    { name: "missing stream", receipt: { ...matching, upstreamRef: "origin/missing" } },
    { name: "stale SHA", receipt: { ...matching, sha: target } },
    { name: "different root", receipt: { ...matching, root: source } },
  ];
  for (const { name, receipt } of receipts) {
    mocks.receipt.mockResolvedValue(receipt);
    const install = await resolveStartupInstallStatus(true, new AbortController().signal);
    expect.soft(install.status.git, name).toMatchObject({
      branch: "HEAD",
      sha,
      upstream: "origin/main",
      upstreamSha: target,
      ahead: 0,
      behind: 1,
      fetchOk: true,
    });
    const schedule = withUpdateInstallStatus(
      { channel: "dev", autoEnabled: true },
      install.status,
      true,
      install.installReceipt,
      root,
    );
    expect.soft(schedule.install?.git?.status, name).toBe("behind");
    expect
      .soft(schedule.install?.git?.installedAtMs, name)
      .toBe(receipt?.root === root && receipt.sha === sha ? 1234 : undefined);
  }
  expect(await git(root, "rev-parse", "HEAD")).toBe(sha);
  expect(await fs.readFile(path.join(root, ".git", "config"), "utf8")).toBe(config);
});
