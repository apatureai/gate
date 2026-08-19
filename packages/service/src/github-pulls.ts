import { withRateLimitRetry } from "@gate/engine";
import type { PullRequestDetails, PullRequestFetcher } from "./hydrate.js";
import { GITHUB_API_ROOT } from "./github-api.js";

/**
 * Concrete App-path GitHub PR adapter (#2 installation token). The orchestration
 * (createDeploymentStatusHandler.resolvePullRequest, hydrateReviewContext's
 * PullRequestFetcher) depends only on these interfaces; this is their
 * production implementation, honoring rate limits and never requesting
 * contents:write.
 */

export interface GitHubPullsClient extends PullRequestFetcher, CommitTreeReader {
  /** Find the open PR whose head is `sha` in this repo (for deployment_status). */
  resolvePullRequest(
    owner: string,
    name: string,
    sha: string,
  ): Promise<{ number: number; headSha: string; baseSha: string } | null>;
}

/**
 * The tree a commit points at.
 *
 * This is what lets the merge carry-forward be a statement of fact instead of an
 * assumption: two commits with the same tree sha have byte-identical content, so
 * a measurement set observed on one describes the other exactly.
 *
 * `GET /repos/{owner}/{repo}/git/commits/{sha}` needs `contents: read`, which
 * the App already has (`app-permissions.ts`), so nothing here widens the
 * permission set. The git-database endpoint is used rather than
 * `/repos/../commits/{sha}` because the latter also serves the full file diff,
 * which this question does not need and a large merge would make expensive.
 */
export interface CommitTreeReader {
  /** The commit's tree sha, or null when the commit cannot be read. */
  getCommitTreeSha(owner: string, name: string, sha: string): Promise<string | null>;
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

  /**
   * Whether this pull request comes from a fork, closed in the safe direction.
   *
   * A fork decides whether Gate will run untrusted code against privileged
   * inputs, so "the payload did not say" has to answer the same way "yes" does.
   * GitHub nulls `head.repo` when the fork has been deleted, and the fallback
   * below compares two names, so a missing head name used to leave the boolean
   * `false`: the permissive answer, on exactly the payload that is hardest to
   * reason about. The Action path was closed already; this is the same rule on
   * the App path.
   */
  const isFork = (pr: RawPull): boolean => {
    if (typeof pr.head.repo?.fork === "boolean") return pr.head.repo.fork;
    const head = pr.head.repo?.full_name;
    const base = pr.base.repo?.full_name;
    if (!head || !base) return true;
    return head !== base;
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

    async getCommitTreeSha(owner, name, sha) {
      const res = await send(`${GITHUB_API_ROOT}/repos/${owner}/${name}/git/commits/${sha}`);
      // A commit Gate cannot read yields NULL, never a throw and never a guess.
      // The only caller compares two trees for equality, and "I could not look"
      // has to be unequal-by-default there: a missing answer that read as a
      // match would copy a measurement set across content nobody compared.
      if (!res.ok) return null;
      const commit = (await res.json()) as { tree?: { sha?: unknown } } | null;
      const tree = commit?.tree?.sha;
      return typeof tree === "string" && tree !== "" ? tree : null;
    },
  };
}
