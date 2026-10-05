import { html, nothing } from "lit";
import type { GitHubPresentationHost } from "./presentation-host.js";

export type GitHubMergePhase = "pending" | "enqueued" | "verifying" | "failed" | "expired";

export type GitHubMergeStatus = {
  phase: GitHubMergePhase;
  message: string;
};

export const GITHUB_MERGE_LABEL_KEYS: Record<GitHubMergePhase, string> = {
  pending: "chat.pullRequests.mergePending",
  enqueued: "chat.pullRequests.mergeQueued",
  verifying: "chat.pullRequests.mergePending",
  failed: "chat.pullRequests.mergeFailed",
  expired: "chat.pullRequests.mergeExpired",
};

export function renderGitHubMergeStatus(
  status: GitHubMergeStatus | undefined,
  t: GitHubPresentationHost["t"],
) {
  if (!status) {
    return nothing;
  }
  return html`<div class="chat-pr__merge-detail" role="status">
    <span class="chat-pr__merge-label">${t(GITHUB_MERGE_LABEL_KEYS[status.phase])}</span>
    <span>${status.message}</span>
  </div>`;
}
