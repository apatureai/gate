import { describe, expect, it } from "vitest";
import { isForkPullRequest } from "../src/fork.js";

/**
 * The fork answer is a gate, not a label: it decides whether preview-bypass and
 * `storageState` secrets survive to the handoff, and whether the repository's
 * `preview-command` may run the pull request's own code on the runner. A gate
 * whose unknown case resolves to "not a fork" is a gate that opens when it
 * cannot see.
 */
describe("isForkPullRequest", () => {
  const named = (head: string, base: string) => ({
    head: { repo: { full_name: head } },
    base: { repo: { full_name: base } },
  });

  it("is false for a branch of the repository itself", () => {
    expect(isForkPullRequest(named("acme/web", "acme/web"))).toBe(false);
  });

  it("is true when the head repository is a different repository", () => {
    expect(isForkPullRequest(named("contributor/web", "acme/web"))).toBe(true);
  });

  it("prefers GitHub's own answer over comparing names", () => {
    expect(
      isForkPullRequest({
        head: { repo: { full_name: "acme/web", fork: true } },
        base: { repo: { full_name: "acme/web" } },
      }),
    ).toBe(true);
    expect(
      isForkPullRequest({
        head: { repo: { full_name: "acme/web", fork: false } },
        base: { repo: { full_name: "acme/web" } },
      }),
    ).toBe(false);
  });

  it("treats a payload that does not say as a fork", () => {
    // `head.repo` is null once the head repository is deleted. Nothing can be
    // built from it either way, so answering "fork" costs a real pull request
    // nothing and stops an unreadable payload from unlocking the fork gates.
    for (const pr of [
      { head: { repo: null }, base: { repo: { full_name: "acme/web" } } },
      { head: {}, base: { repo: { full_name: "acme/web" } } },
      { head: { repo: { full_name: "acme/web" } }, base: { repo: null } },
      { head: { repo: {} }, base: { repo: {} } },
    ] as const) {
      expect(isForkPullRequest(pr), JSON.stringify(pr)).toBe(true);
    }
  });
});
