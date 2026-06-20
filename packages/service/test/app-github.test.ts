import { describe, expect, it, vi } from "vitest";
import { createAppReviewClient } from "../src/index.js";

const target = { owner: "acme", name: "web", prNumber: 42, headSha: "abc123" };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

describe("createAppReviewClient (#62 App-path GitHub client)", () => {
  it("creates a sticky comment via the installation token, never contents:write", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ id: 5, node_id: "n5", body: "hi" });
    }) as unknown as typeof fetch;

    const client = createAppReviewClient("inst-token", target, fetchImpl);
    const created = await client.comments.createComment("hi");

    expect(created).toEqual({ id: 5, nodeId: "n5", body: "hi" });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/web/issues/42/comments");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer inst-token");
    // never a contents write
    expect(calls.every((c) => !/\/contents\//.test(c.url))).toBe(true);
  });

  it("publishes a completed check run attached to the head sha", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createAppReviewClient("t", target, fetchImpl);
    await client.publishCheckRun({ name: "Apature Gate", conclusion: "success", title: "Ship", summary: "ok" });

    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/web/check-runs");
    const sent = JSON.parse((calls[0]?.init?.body as string) ?? "{}");
    expect(sent).toMatchObject({ name: "Apature Gate", head_sha: "abc123", status: "completed", conclusion: "success" });
  });

  it("skips the comment edit when the node id changed (optimistic guard)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/issues/comments/5")) return jsonResponse({ id: 5, node_id: "DIFFERENT", body: "x" });
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createAppReviewClient("t", target, fetchImpl);
    const res = await client.comments.updateComment(5, "new", "expected-node");
    expect(res.updated).toBe(false);
  });

  it("throws on a failed GitHub call", async () => {
    const fetchImpl = (async () => jsonResponse({}, false, 403)) as unknown as typeof fetch;
    const client = createAppReviewClient("t", target, fetchImpl);
    await expect(client.comments.createComment("x")).rejects.toThrow(/create comment failed: 403/);
  });
});
