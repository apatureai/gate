import { DEFAULT_CONFIG } from "@gate/config";
import { describe, expect, it, vi } from "vitest";
import { createGitHubRepoConfigClient } from "../src/repo-config.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function content(text: string): { type: string; encoding: string; content: string } {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from(text, "utf8").toString("base64"),
  };
}

describe("createGitHubRepoConfigClient", () => {
  it("loads and normalizes .designreview.yml from the PR head ref", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        content(`
rules:
  gate: blockers
  min_severity_to_comment: major
brand: Checkout UX
`),
      ),
    ) as unknown as typeof fetch;

    const config = await createGitHubRepoConfigClient("token", fetchImpl).loadConfig("acme", "web", "abc123");

    expect(config.rules.gate).toBe("blockers");
    expect(config.rules.minSeverityToComment).toBe("major");
    expect(config.brand).toBe("Checkout UX");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/web/contents/.designreview.yml?ref=abc123",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer token" }),
      }),
    );
  });

  it("falls back to DEFAULT_CONFIG when the repo has no config file", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;

    await expect(createGitHubRepoConfigClient("token", fetchImpl).loadConfig("acme", "web", "abc123")).resolves.toEqual(
      DEFAULT_CONFIG,
    );
  });

  it("surfaces schema errors so the App path can publish a neutral setup Check Run", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(content("rules:\n  gate: always-block\n"))) as unknown as typeof fetch;

    await expect(createGitHubRepoConfigClient("token", fetchImpl).loadConfig("acme", "web", "abc123")).rejects.toThrow(
      /Invalid .designreview.yml/,
    );
  });
});
