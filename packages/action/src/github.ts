import type { CheckRun, GitHubCommentsApi, IssueComment } from "@gate/delivery";
import { withRateLimitRetry } from "@gate/engine";
import type { ProviderComment } from "./preview.js";

/**
 * Thin GitHub REST adapter for the Action path, using the runner's GITHUB_TOKEN.
 * It only ever reads contents and writes issue comments + check runs, never
 * `contents: write`. The same delivery components run on the App path with an
 * installation token injected instead.
 */
const API_ROOT = "https://api.github.com";

export interface GitHubTarget {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

export interface GitHubApi {
  comments: GitHubCommentsApi;
  /** PR comments shaped for provider-bot preview discovery (author + body). */
  listPreviewComments(): Promise<ProviderComment[]>;
  /** Re-read the PR head immediately before delivery to prevent stale publish. */
  getCurrentHeadSha(): Promise<string>;
  publishCheckRun(run: CheckRun): Promise<void>;
}

interface RawComment {
  id: number;
  node_id: string;
  body: string | null;
  user?: { login?: string } | null;
}

interface RawPullRequest {
  head?: { sha?: string };
}

export function createGitHubApi(
  token: string,
  target: GitHubTarget,
  fetchImpl: typeof fetch = fetch,
): GitHubApi {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "apature-gate",
  };
  const base = `${API_ROOT}/repos/${target.owner}/${target.repo}`;

  // All calls honor GitHub primary + secondary rate limits (#49).
  const send = (url: string, init?: RequestInit): Promise<Response> =>
    withRateLimitRetry(() => fetchImpl(url, init));

  async function rawComments(): Promise<RawComment[]> {
    const res = await send(`${base}/issues/${target.prNumber}/comments?per_page=100`, { headers });
    if (!res.ok) throw new Error(`list comments failed: ${res.status}`);
    return (await res.json()) as RawComment[];
  }

  const comments: GitHubCommentsApi = {
    async listComments(): Promise<IssueComment[]> {
      return (await rawComments()).map((c) => ({ id: c.id, nodeId: c.node_id, body: c.body ?? "" }));
    },
    async createComment(body: string): Promise<IssueComment> {
      const res = await send(`${base}/issues/${target.prNumber}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`create comment failed: ${res.status}`);
      const c = (await res.json()) as RawComment;
      return { id: c.id, nodeId: c.node_id, body: c.body ?? "" };
    },
    async updateComment(id: number, body: string, expectedNodeId: string): Promise<{ updated: boolean }> {
      // Optimistic guard: re-read; skip if the comment was replaced (node_id
      // changed). The authoritative supersession backstop is the publish-time
      // SHA guard (#4).
      const current = await send(`${base}/issues/comments/${id}`, { headers });
      if (current.ok) {
        const c = (await current.json()) as RawComment;
        if (c.node_id !== expectedNodeId) return { updated: false };
      }
      const res = await send(`${base}/issues/comments/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`update comment failed: ${res.status}`);
      return { updated: true };
    },
  };

  return {
    comments,
    async listPreviewComments(): Promise<ProviderComment[]> {
      return (await rawComments()).map((c) => ({ author: c.user?.login ?? "", body: c.body ?? "" }));
    },
    async getCurrentHeadSha(): Promise<string> {
      const res = await send(`${base}/pulls/${target.prNumber}`, { headers });
      if (!res.ok) throw new Error(`get pull request failed: ${res.status}`);
      const pr = (await res.json()) as RawPullRequest;
      if (!pr.head?.sha) throw new Error("get pull request returned no head sha");
      return pr.head.sha;
    },
    async publishCheckRun(run: CheckRun): Promise<void> {
      const res = await send(`${base}/check-runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: run.name,
          head_sha: target.headSha,
          status: "completed",
          conclusion: run.conclusion,
          details_url: run.detailsUrl,
          output: { title: run.title, summary: run.summary },
        }),
      });
      if (!res.ok) throw new Error(`create check run failed: ${res.status}`);
    },
  };
}
