import type { CheckRun, GitHubCommentsApi, IssueComment } from "@gate/delivery";
import { withRateLimitRetry } from "@gate/engine";

/**
 * App-path GitHub REST client (installation token): the comment + check-run
 * surface `runHostedReview` delivers through (#10/#11). It is the App-path peer
 * of the Action path's `createGitHubApi` — kept in `@gate/service` (alongside
 * `createGitHubPullsClient`) rather than imported from `@gate/action`, since the
 * service must not depend on the top-level Action package. It only reads contents
 * and writes issue comments + check runs — **never `contents: write`**. All calls
 * honor GitHub primary/secondary rate limits (#49).
 */
const API_ROOT = "https://api.github.com";

export interface AppReviewTarget {
  owner: string;
  name: string;
  prNumber: number;
  /** PR head SHA the check run is attached to. */
  headSha: string;
}

export interface AppReviewClient {
  comments: GitHubCommentsApi;
  publishCheckRun(run: CheckRun): Promise<void>;
}

interface RawComment {
  id: number;
  node_id: string;
  body: string | null;
}

export function createAppReviewClient(
  token: string,
  target: AppReviewTarget,
  fetchImpl: typeof fetch = fetch,
): AppReviewClient {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "apature-gate",
  };
  const base = `${API_ROOT}/repos/${target.owner}/${target.name}`;
  const send = (url: string, init?: RequestInit): Promise<Response> =>
    withRateLimitRetry(() => fetchImpl(url, init));

  const comments: GitHubCommentsApi = {
    async listComments(): Promise<IssueComment[]> {
      const res = await send(`${base}/issues/${target.prNumber}/comments?per_page=100`, { headers });
      if (!res.ok) throw new Error(`list comments failed: ${res.status}`);
      const raw = (await res.json()) as RawComment[];
      return raw.map((c) => ({ id: c.id, nodeId: c.node_id, body: c.body ?? "" }));
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
      // Optimistic guard: skip the edit if the comment was replaced (node_id
      // changed); the authoritative supersession backstop is the publish-time
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
