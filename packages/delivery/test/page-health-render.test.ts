import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import { buildCheckRun, mapCheckRunConclusion, renderStickyComment } from "../src/index.js";

const golden = loadGoldenReviewResult();

function withFootnote(footnote?: string) {
  return { ...golden, artifacts: { ...golden.artifacts, ...(footnote !== undefined ? { pageHealthFootnote: footnote } : {}) } };
}

describe("page-health footnote rendering (gate #156)", () => {
  it("renders the caveat once in the sticky comment when present", () => {
    const body = renderStickyComment(withFootnote("1 console error observed during capture."), { headSha: "abc1234" });
    expect(body).toContain("Capture health:");
    expect(body).toContain("console error");
    expect(body.match(/Capture health:/g)).toHaveLength(1);
  });

  it("a clean result (no footnote) produces no extra caveat", () => {
    const body = renderStickyComment(withFootnote(undefined), { headSha: "abc1234" });
    expect(body).not.toContain("Capture health:");
  });

  it("keeps the version-lineage footer separate from the health caveat", () => {
    const body = renderStickyComment(withFootnote("Layout instability detected."), { headSha: "abc1234" });
    expect(body).toContain("Capture health:");
    expect(body).toContain(`engine ${golden.metadata.engineVersion}`); // lineage footer still present, distinct
  });

  it("surfaces the caveat in the Check Run summary without changing the conclusion", () => {
    const withHealth = buildCheckRun(withFootnote("2 failed requests during capture."), "blockers");
    const without = buildCheckRun(withFootnote(undefined), "blockers");
    expect(withHealth.summary).toContain("Capture health:");
    // The conclusion is a pure function of grade+gate — the footnote never moves it.
    expect(withHealth.conclusion).toBe(without.conclusion);
    expect(withHealth.conclusion).toBe(mapCheckRunConclusion(golden.grade, "blockers"));
    expect(withHealth.title).toBe(without.title);
  });

  it("sanitizes an injected footnote before publication (untrusted display text)", () => {
    const evil = "<img src=x> [pwn](https://evil.example) cc @octocat";
    const body = renderStickyComment(withFootnote(evil), { headSha: "abc1234" });
    expect(body).not.toMatch(/(?<!\\)<img/); // no live HTML tag
    expect(body).not.toContain("](https://evil.example)"); // no live link
    expect(body).not.toContain("@octocat"); // mention neutralized
  });
});
