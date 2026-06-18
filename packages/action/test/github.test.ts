import { describe, expect, it, vi } from "vitest";
import { createGitHubApi } from "../src/github.js";

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function fakeFetch(responder: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return responder(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const target = { owner: "acme", repo: "web", prNumber: 42, headSha: "sha123" };

describe("createGitHubApi", () => {
  it("creates check runs against the head SHA, never writing contents", async () => {
    const { impl, calls } = fakeFetch(() => new Response("{}", { status: 201 }));
    const gh = createGitHubApi("tok", target, impl);
    await gh.publishCheckRun({ name: "Apature Gate", conclusion: "neutral", title: "Needs work", summary: "s" });

    const call = calls.at(-1)!;
    expect(call.url).toBe("https://api.github.com/repos/acme/web/check-runs");
    expect(call.method).toBe("POST");
    expect(call.body).toMatchObject({
      name: "Apature Gate",
      head_sha: "sha123",
      status: "completed",
      conclusion: "neutral",
      output: { title: "Needs work", summary: "s" },
    });
    // No call ever touches the contents API.
    expect(calls.every((c) => !c.url.includes("/contents/"))).toBe(true);
  });

  it("maps preview comments to author + body for discovery", async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify([{ id: 1, node_id: "n1", body: "preview here", user: { login: "vercel[bot]" } }]),
          { status: 200 },
        ),
    );
    const gh = createGitHubApi("tok", target, impl);
    const comments = await gh.listPreviewComments();
    expect(comments).toEqual([{ author: "vercel[bot]", body: "preview here" }]);
  });

  it("updates the sticky comment only when the node_id still matches", async () => {
    const responder = vi
      .fn()
      // GET re-read returns same node_id
      .mockReturnValueOnce(new Response(JSON.stringify({ id: 5, node_id: "keep", body: "old" }), { status: 200 }))
      // PATCH succeeds
      .mockReturnValueOnce(new Response("{}", { status: 200 }));
    const { impl, calls } = fakeFetch((u, i) => responder(u, i) as Response);
    const gh = createGitHubApi("tok", target, impl);

    const res = await gh.comments.updateComment(5, "new body", "keep");
    expect(res.updated).toBe(true);
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("retries on a GitHub rate-limit response (#49)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ id: 1, node_id: "n1", body: "ok" }), { status: 201 });
    }) as unknown as typeof fetch;
    const gh = createGitHubApi("tok", target, fetchImpl);
    const comment = await gh.comments.createComment("hi");
    expect(comment.id).toBe(1);
    expect(calls).toBe(2); // retried after the 429
  });

  it("skips the update when the comment was replaced (node_id changed)", async () => {
    const { impl, calls } = fakeFetch(
      () => new Response(JSON.stringify({ id: 5, node_id: "different", body: "x" }), { status: 200 }),
    );
    const gh = createGitHubApi("tok", target, impl);
    const res = await gh.comments.updateComment(5, "new body", "expected");
    expect(res.updated).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
