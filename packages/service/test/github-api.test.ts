/**
 * The GitHub REST API base URL, single-sourced from the byte-identical copies
 * that were hardcoded in app-github / github-pulls / repo-config.
 */
import { describe, expect, it } from "vitest";
import { GITHUB_API_ROOT } from "../src/index.js";

describe("GITHUB_API_ROOT", () => {
  it("is the GitHub REST API base URL", () => {
    expect(GITHUB_API_ROOT).toBe("https://api.github.com");
  });

  it("has no trailing slash (callers append /repos/...)", () => {
    expect(GITHUB_API_ROOT.endsWith("/")).toBe(false);
  });
});
