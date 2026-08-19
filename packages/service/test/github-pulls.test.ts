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

  it("getCommitTreeSha reads the git-database commit object under contents:read", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ sha: "abc", tree: { sha: "treesha" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createGitHubPullsClient("tok", fetchImpl);
    expect(await client.getCommitTreeSha("acme", "web", "abc")).toBe("treesha");
    // The git-database endpoint, not /repos/../commits/{sha}: this question does
    // not need the full file diff the latter also serves. Both need only
    // contents:read, so the merge carry-forward widens no permission.
    expect(urls[0]).toBe("https://api.github.com/repos/acme/web/git/commits/abc");
  });

  it("getCommitTreeSha returns null rather than guessing when the commit cannot be read", async () => {
    // The only caller compares two trees for equality, so a missing answer must
    // never be able to read as a match.
    const missing = createGitHubPullsClient("tok", jsonFetch({}));
    expect(await missing.getCommitTreeSha("acme", "web", "gone")).toBeNull();

    const shapeless = createGitHubPullsClient(
      "tok",
      jsonFetch({ "/git/commits/abc": { body: { sha: "abc", tree: { sha: 7 } } } }),
    );
    expect(await shapeless.getCommitTreeSha("acme", "web", "abc")).toBeNull();

    const empty = createGitHubPullsClient(
      "tok",
      jsonFetch({ "/git/commits/abc": { body: { sha: "abc", tree: { sha: "" } } } }),
    );
    expect(await empty.getCommitTreeSha("acme", "web", "abc")).toBeNull();
  });
});

describe("a payload that will not say whether it is a fork", () => {
  /**
   * GitHub nulls `head.repo` once a fork is deleted, and the name comparison
   * that stands in for the missing flag then has nothing on one side. That used
   * to answer `false`, which is the permissive direction on the one decision
   * that governs whether untrusted code meets privileged inputs. The Action path
   * closed this; the App path had not.
   */
  it("treats a missing head repository as a fork", async () => {
    const client = createGitHubPullsClient(
      "tok",
      jsonFetch({
        "/pulls/9": {
          body: {
            number: 9,
            title: "From a fork that no longer exists",
            body: "desc",
            state: "open",
            head: { sha: "abc", repo: null },
            base: { sha: "base", repo: { default_branch: "main", full_name: "acme/web" } },
          },
        },
      }),
    );

    expect((await client.fetchPullRequest("acme", "web", 9))?.isFork).toBe(true);
  });

  it("treats a missing base repository as a fork too", async () => {
    const client = createGitHubPullsClient(
      "tok",
      jsonFetch({
        "/pulls/10": {
          body: {
            number: 10,
            title: "Half a payload",
            body: "desc",
            state: "open",
            head: { sha: "abc", repo: { full_name: "someone/web" } },
            base: { sha: "base", repo: null },
          },
        },
      }),
    );

    expect((await client.fetchPullRequest("acme", "web", 10))?.isFork).toBe(true);
  });

  it("still reads a same-repository pull request as not a fork", async () => {
    // The control. Closing the unknown case must not call every pull request a
    // fork, which would turn the safety rule into a blanket refusal.
    const client = createGitHubPullsClient(
      "tok",
      jsonFetch({
        "/pulls/11": {
          body: {
            number: 11,
            title: "Ordinary",
            body: "desc",
            state: "open",
            head: { sha: "abc", repo: { full_name: "acme/web" } },
            base: { sha: "base", repo: { default_branch: "main", full_name: "acme/web" } },
          },
        },
      }),
    );

    expect((await client.fetchPullRequest("acme", "web", 11))?.isFork).toBe(false);
  });
});
