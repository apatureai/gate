import { DEFAULT_CONFIG } from "@gate/config";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubComponentLibraryClient,
  createGitHubRepoConfigClient,
} from "../src/repo-config.js";

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
  it("loads and normalizes .gate.yml from the PR head ref", async () => {
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
      "https://api.github.com/repos/acme/web/contents/.gate.yml?ref=abc123",
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
      /Invalid .gate.yml/,
    );
  });
});

/**
 * The App path has no checkout and neither does the critique engine, so this one
 * GitHub read is the only way a hosted review's deep prompt can be told which
 * component library the UI is built with.
 *
 * Everything here is best-effort by design. The engine treats the field as
 * additive, so the worst outcome of any failure is a review grounded on tokens
 * and brand, which is what every hosted review was grounded on before this
 * existed. Failing the review instead would trade a real review for a missing
 * paragraph of rubric.
 */
describe("createGitHubComponentLibraryClient", () => {
  it("names the libraries in the manifest at the PR head", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(content(JSON.stringify({ dependencies: { "@mui/material": "^5" } }))),
    ) as unknown as typeof fetch;

    await expect(
      createGitHubComponentLibraryClient("token", fetchImpl).detect("acme", "web", "abc123"),
    ).resolves.toEqual(["mui"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/web/contents/package.json?ref=abc123",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer token" }),
      }),
    );
  });

  it("names nothing when the repository has no manifest", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    await expect(
      createGitHubComponentLibraryClient("token", fetchImpl).detect("acme", "web", "abc123"),
    ).resolves.toEqual([]);
  });

  it("names nothing when the manifest is not parseable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(content("not json {"))) as unknown as typeof fetch;
    await expect(
      createGitHubComponentLibraryClient("token", fetchImpl).detect("acme", "web", "abc123"),
    ).resolves.toEqual([]);
  });

  it("never turns a GitHub failure into a failed review", async () => {
    const offline = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      createGitHubComponentLibraryClient("token", offline).detect("acme", "web", "abc123"),
    ).resolves.toEqual([]);

    const forbidden = vi.fn(async () => jsonResponse({ message: "Forbidden" }, 403)) as unknown as typeof fetch;
    await expect(
      createGitHubComponentLibraryClient("token", forbidden).detect("acme", "web", "abc123"),
    ).resolves.toEqual([]);
  });
});
