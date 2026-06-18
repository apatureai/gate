import { describe, expect, it } from "vitest";
import { createGitHubPullsClient } from "../src/github-pulls.js";

function jsonFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (url: string) => {
    for (const [needle, res] of Object.entries(routes)) {
      if (url.includes(needle)) return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("createGitHubPullsClient", () => {
  it("fetchPullRequest returns title/body/defaultBranch and detects same-repo PRs as non-fork", async () => {
    const client = createGitHubPullsClient(
      "tok",
      jsonFetch({
        "/pulls/42": {
          body: {
            number: 42,
            title: "Redesign",
            body: "desc",
            state: "open",
            head: { sha: "abc", repo: { fork: false, full_name: "acme/web" } },
            base: { sha: "base", repo: { default_branch: "main", full_name: "acme/web" } },
          },
        },
      }),
    );
    expect(await client.fetchPullRequest("acme", "web", 42)).toEqual({
      defaultBranch: "main",
      title: "Redesign",
      body: "desc",
      isFork: false,
    });
  });

  it("detects a fork PR (different head/base repo)", async () => {
    const client = createGitHubPullsClient(
      "tok",
      jsonFetch({
        "/pulls/7": {
          body: {
            number: 7,
            title: "Fork PR",
            body: null,
            state: "open",
            head: { sha: "h", repo: { full_name: "contributor/web" } },
            base: { sha: "b", repo: { default_branch: "main", full_name: "acme/web" } },
          },
        },
      }),
    );
    expect((await client.fetchPullRequest("acme", "web", 7))?.isFork).toBe(true);
  });

  it("resolvePullRequest picks the open PR whose head is the deployment sha", async () => {
    const client = createGitHubPullsClient(
      "tok",
      jsonFetch({
        "/commits/abc/pulls": {
          body: [
            { number: 1, state: "closed", head: { sha: "old" }, base: { sha: "b" } },
            { number: 42, title: "x", body: null, state: "open", head: { sha: "abc" }, base: { sha: "base" } },
          ],
        },
      }),
    );
    expect(await client.resolvePullRequest("acme", "web", "abc")).toEqual({
      number: 42,
      headSha: "abc",
      baseSha: "base",
    });
  });

  it("returns null when no PR matches the sha / the PR is missing", async () => {
    const client = createGitHubPullsClient("tok", jsonFetch({ "/commits/zzz/pulls": { body: [] } }));
    expect(await client.resolvePullRequest("acme", "web", "zzz")).toBeNull();
    expect(await client.fetchPullRequest("acme", "web", 999)).toBeNull(); // 404
  });
});
