import hostedGitInfo from "hosted-git-info";
import { executeGitCommand } from "./git-exec.js";
import { DEV_BRANCH } from "./update-channels.js";

export type GitFetchTarget = { remote: string; mergeRef: string };

const DEV_COMMIT_LIMIT = 5;
const DEV_COMMIT_SUBJECT_MAX_LENGTH = 120;
const DEV_COMMIT_LOG_MAX_OUTPUT_BYTES = 8 * 1024;

/** Select source authority before requiring its local tracking ref to exist. */
export async function readGitUpdateFetchTarget(
  readGit: (...args: string[]) => Promise<string | null>,
  branch: string,
  useDevDefault = false,
): Promise<GitFetchTarget | null> {
  const [remote, mergeRefs] = await Promise.all([
    readGit("config", "--get", `branch.${branch}.remote`),
    readGit("config", "--get-all", `branch.${branch}.merge`),
  ]);
  const mergeRef = mergeRefs?.split("\n")[0];
  if (remote && mergeRef) {
    return { remote, mergeRef };
  }
  if (!useDevDefault || remote || mergeRefs) {
    return null;
  }
  const currentBranch = await readGit("rev-parse", "--abbrev-ref", "HEAD");
  // A named checkout with an existing untracked main is intentionally unmanaged.
  // Detached installs and new main branches use origin, never an arbitrary remote.
  if (
    !currentBranch ||
    (currentBranch !== "HEAD" &&
      (await readGit("show-ref", "--verify", `refs/heads/${DEV_BRANCH}`)))
  ) {
    return null;
  }
  return (await readGit("remote", "get-url", "--", "origin"))
    ? { remote: "origin", mergeRef: `refs/heads/${DEV_BRANCH}` }
    : null;
}

/** Apply the selected source’s fetch mapping without changing repository configuration. */
export async function resolveGitUpdateTrackingRef(
  readGit: (...args: string[]) => Promise<string | null>,
  branch: string,
  target: GitFetchTarget,
): Promise<string | null> {
  return readGit(
    "-c",
    `branch.${branch}.remote=${target.remote}`,
    "-c",
    `branch.${branch}.merge=${target.mergeRef}`,
    "rev-parse",
    "--symbolic-full-name",
    `${branch}@{upstream}`,
  );
}

export async function resolveGitRepositoryMetadata(
  readGit: (...args: string[]) => Promise<string | null>,
  target: GitFetchTarget | null,
): Promise<{ repositoryUrl?: string }> {
  const remote = target?.remote;
  const remoteUrl =
    remote && remote !== "." ? await readGit("remote", "get-url", "--", remote) : null;
  // Git accepts relative local remotes that hosted-git-info treats as npm shorthands.
  const repository =
    remoteUrl && /^(?:(?:https?|ssh|git):\/\/|git@github\.com:)/u.test(remoteUrl)
      ? hostedGitInfo.fromUrl(remoteUrl)
      : undefined;
  // Never expose remote credentials or local paths in update announcements.
  const repositoryUrl =
    repository?.type === "github" ? repository.browse({ noCommittish: true }) : undefined;
  return repositoryUrl ? { repositoryUrl } : {};
}

export async function resolveDevGitCommits(params: {
  root: string;
  currentSha: string;
  upstreamSha: string;
  signal: AbortSignal;
}): Promise<Array<{ sha: string; subject: string }>> {
  const result = await executeGitCommand(
    params.root,
    [
      "log",
      "--format=%h%x09%s",
      `--max-count=${DEV_COMMIT_LIMIT}`,
      `${params.currentSha}..${params.upstreamSha}`,
    ],
    {
      timeoutMs: 2500,
      signal: params.signal,
      killProcessTree: true,
      maxOutputBytes: { stdout: DEV_COMMIT_LOG_MAX_OUTPUT_BYTES, stderr: 1024 },
    },
  ).catch(() => null);
  if (!result || result.code !== 0 || result.termination !== "exit") {
    return [];
  }
  return result.stdout
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf("\t");
      const sha = separator < 0 ? "" : line.slice(0, separator).trim();
      if (!sha) {
        return [];
      }
      return [
        {
          sha,
          subject: line
            .slice(separator + 1)
            .trim()
            .slice(0, DEV_COMMIT_SUBJECT_MAX_LENGTH),
        },
      ];
    })
    .slice(0, DEV_COMMIT_LIMIT);
}
