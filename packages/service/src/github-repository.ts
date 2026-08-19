import { withRateLimitRetry } from "@gate/engine";
import { GITHUB_API_ROOT } from "./github-api.js";

/**
 * "Which commit is this repository's default branch on right now?"
 *
 * A push answers that question in its payload. An INSTALLATION does not: the
 * `installation` and `installation_repositories` deliveries name the repositories
 * and nothing about their branches, so the one thing that lets a freshly
 * installed repository be scoped has to be read back from GitHub.
 *
 * NO NEW PERMISSION, and this is the reason the whole installation path is
 * allowed to exist. `GET /repos/{owner}/{repo}` needs only the Metadata scope,
 * which every GitHub App holds mandatorily, and
 * `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` needs `contents: read`,
 * which Gate already requests and which a review already spends on `.gate.yml`.
 * Nothing here writes.
 *
 * The git-database ref endpoint is used rather than `/commits/{branch}`, for the
 * same reason `getCommitTreeSha` uses the git-database commit endpoint: the
 * commits endpoint also serves the commit's full file diff, which this question
 * does not need and a large merge would make expensive.
 */
export interface DefaultBranchHead {
  /** The branch name as the repository defines it: never assumed to be `main`. */
  defaultBranch: string;
  /** The commit at that branch's tip when it was read. */
  commitSha: string;
}

export interface RepositoryHeadReader {
  /**
   * The repository's default branch and its tip commit, or null when either
   * cannot be read.
   *
   * NULL, NEVER A GUESS AND NEVER A THROW. A repository can be deleted, renamed,
   * made private or emptied between the installation delivery and this read, and
   * a brand new repository has no commit on its default branch at all. Every one
   * of those means the same thing to the only caller: this repository records no
   * baseline, which is exactly where it already was.
   */
  readDefaultBranchHead(owner: string, name: string): Promise<DefaultBranchHead | null>;
}

/** Encode a ref path segment-wise: `release/v2` must stay two path segments. */
function encodeRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

export function createGitHubRepositoryClient(
  token: string,
  fetchImpl: typeof fetch = fetch,
): RepositoryHeadReader {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "apature-gate",
  };
  const send = (url: string): Promise<Response> => withRateLimitRetry(() => fetchImpl(url, { headers }));

  return {
    async readDefaultBranchHead(owner, name) {
      const repo = await send(`${GITHUB_API_ROOT}/repos/${owner}/${name}`);
      if (!repo.ok) return null;
      const meta = (await repo.json()) as { default_branch?: unknown } | null;
      const defaultBranch = meta?.default_branch;
      if (typeof defaultBranch !== "string" || defaultBranch === "") return null;

      const ref = await send(
        `${GITHUB_API_ROOT}/repos/${owner}/${name}/git/ref/heads/${encodeRefPath(defaultBranch)}`,
      );
      // 404 here is the ordinary shape of an empty repository: it has a default
      // branch NAME and no commit on it. There is nothing to measure and nothing
      // has gone wrong.
      if (!ref.ok) return null;
      const body = (await ref.json()) as { object?: { sha?: unknown } } | null;
      const sha = body?.object?.sha;
      if (typeof sha !== "string" || sha === "") return null;
      return { defaultBranch, commitSha: sha };
    },
  };
}
