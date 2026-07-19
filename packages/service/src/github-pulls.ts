import { withRateLimitRetry } from "@gate/engine";
import type { PullRequestDetails, PullRequestFetcher } from "./hydrate.js";
import { GITHUB_API_ROOT } from "./github-api.js";

/**
 * Concrete App-path GitHub PR adapter (#2 installation token). The orchestration
 * (createDeploymentStatusHandler.resolvePullRequest, hydrateReviewContext's
 * PullRequestFetcher) depends only on these interfaces — this is their
 * production implementation, honoring rate limits and never requesting
 * contents:write.
 */

export interface GitHubPullsClient extends PullRequestFetcher {
  /** Find the open PR whose head is `sha` in this repo (for deployment_status). */
  resolvePullRequest(
    owner: string,
    name: string,
    sha: string,
  ): Promise<{ number: number; headSha: string; baseSha: string } | null>;
}

interface RawPull {
  number: number;
  title: string;
  body: string | null;
  state: string;
  head: { sha: string; repo?: { fork?: boolean; full_name?: string } | null };
  base: { sha: string; repo?: { default_branch?: string; full_name?: string } | null };
}

export function createGitHubPullsClient(token: string, fetchImpl: typeof fetch = fetch): GitHubPullsClient {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "apature-gate",
  };
  const send = (url: string): Promise<Response> => withRateLimitRetry(() => fetchImpl(url, { headers }));

  const isFork = (pr: RawPull): boolean => {
    if (typeof pr.head.repo?.fork === "boolean") return pr.head.repo.fork;
    const head = pr.head.repo?.full_name;
    const base = pr.base.repo?.full_name;
    return !!head && !!base && head !== base;
  };

  return {
    async fetchPullRequest(owner, name, prNumber): Promise<PullRequestDetails | null> {
      const res = await send(`${GITHUB_API_ROOT}/repos/${owner}/${name}/pulls/${prNumber}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`fetch pull #${prNumber} failed: ${res.status}`);
      const pr = (await res.json()) as RawPull;
      return {
        defaultBranch: pr.base.repo?.default_branch ?? "main",
        title: pr.title,
        body: pr.body,
        isFork: isFork(pr),
      };
    },

    async resolvePullRequest(owner, name, sha) {
      // List PRs associated with the commit; take the open one whose head is sha.
      const res = await send(`${GITHUB_API_ROOT}/repos/${owner}/${name}/commits/${sha}/pulls`);
      if (!res.ok) throw new Error(`resolve pull for ${sha} failed: ${res.status}`);
      const pulls = (await res.json()) as RawPull[];
      const pr = pulls.find((p) => p.state === "open" && p.head.sha === sha) ?? pulls.find((p) => p.head.sha === sha);
      if (!pr) return null;
      return { number: pr.number, headSha: pr.head.sha, baseSha: pr.base.sha };
    },
  };
}
