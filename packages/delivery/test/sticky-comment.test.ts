import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import {
  findingsAtOrAbove,
  type GitHubCommentsApi,
  type IssueComment,
  renderStickyComment,
  STICKY_MARKER,
  upsertStickyComment,
} from "../src/index.js";

const golden = loadGoldenReviewResult();

describe("renderStickyComment", () => {
  const body = renderStickyComment(golden, { headSha: "abcdef1234567890", runUrl: "https://gate.app/r/1" });

  it("includes the hidden marker and the reviewed SHA", () => {
    expect(body).toContain(STICKY_MARKER);
    expect(body).toContain("reviewed `abcdef1`");
  });

  it("renders should-fix and nits in collapsed details", () => {
    expect(body).toContain("<details>");
    expect(body).toContain("Should fix (");
    expect(body).toContain("Nits (");
  });

  it("renders the not-reviewed section (never silently dropped)", () => {
    expect(body).toContain("### Not reviewed");
    expect(body).toContain(golden.notReviewed[0]!);
  });

  it("includes a page-health footnote with engine/model/ui-dna lineage", () => {
    expect(body).toContain(`model ${golden.metadata.model}`);
    expect(body).toContain(`ui-dna ${golden.metadata.uiDnaVersion}`);
    expect(body).toContain("[run details](https://gate.app/r/1)");
  });

  it("renders a blockers table when blockers exist", () => {
    const withBlocker = {
      ...golden,
      findings: [{ ...golden.findings[0]!, severity: "blocker" as const, title: "Contrast fails WCAG" }],
    };
    const out = renderStickyComment(withBlocker, { headSha: "abc1234" });
    expect(out).toContain("### ⛔ Blockers");
    expect(out).toContain("Contrast fails WCAG");
  });

  it("surfaces a capture caveat when provided", () => {
    const out = renderStickyComment(golden, { headSha: "abc1234", captureCaveat: "Capture was unstable on 1 route." });
    expect(out).toContain("Capture was unstable");
  });

  it("applies min_severity_to_comment: omits findings below the threshold", () => {
    // golden has one major, one minor, one nit finding.
    const out = renderStickyComment(golden, { headSha: "abc1234", minSeverityToComment: "major" });
    expect(out).toContain("Primary CTA uses an off-brand color"); // major — kept (in Should fix)
    expect(out).toContain("Should fix (1)"); // the major finding still lives here
    expect(out).not.toContain("Pricing card grid overflows"); // minor — omitted
    expect(out).not.toContain("Inconsistent vertical rhythm"); // nit — omitted
    expect(out).not.toContain("Nits ("); // nits section empties out
  });

  it("still renders the grade and not-reviewed section even when findings are filtered out", () => {
    const out = renderStickyComment(golden, { headSha: "abc1234", minSeverityToComment: "blocker" });
    expect(out).toContain("Needs work"); // grade reflects the engine verdict, not the filter
    expect(out).toContain("### Not reviewed");
    expect(out).not.toContain("Primary CTA uses an off-brand color"); // all findings below blocker
  });

  it("an unset threshold lists everything (backward-compatible)", () => {
    const out = renderStickyComment(golden, { headSha: "abc1234" });
    expect(out).toContain("Should fix (");
    expect(out).toContain("Nits (");
  });
});

describe("findingsAtOrAbove", () => {
  it("keeps only findings at or above the floor", () => {
    const keep = findingsAtOrAbove(golden.findings, "major");
    expect(keep.map((f) => f.severity)).toEqual(["major"]);
  });

  it("defaults to nit (keeps everything) when unset", () => {
    expect(findingsAtOrAbove(golden.findings)).toHaveLength(golden.findings.length);
  });

  it("blocker floor keeps only blockers", () => {
    expect(findingsAtOrAbove(golden.findings, "blocker")).toHaveLength(0);
  });
});

function fakeApi(existing: IssueComment[], updated = true): GitHubCommentsApi {
  return {
    listComments: vi.fn(async () => existing),
    createComment: vi.fn(async (body: string) => ({ id: 1, nodeId: "n1", body })),
    updateComment: vi.fn(async () => ({ updated })),
  };
}

describe("upsertStickyComment", () => {
  it("creates the comment when none exists", async () => {
    const api = fakeApi([]);
    const out = await upsertStickyComment(api, `${STICKY_MARKER}\nhi`);
    expect(out).toEqual({ action: "created", commentId: 1 });
    expect(api.createComment).toHaveBeenCalled();
  });

  it("updates the existing sticky comment found by marker", async () => {
    const api = fakeApi([{ id: 7, nodeId: "node7", body: `${STICKY_MARKER}\nold` }]);
    const out = await upsertStickyComment(api, `${STICKY_MARKER}\nnew`);
    expect(out).toEqual({ action: "updated", commentId: 7 });
    expect(api.updateComment).toHaveBeenCalledWith(7, expect.stringContaining("new"), "node7");
  });

  it("skips when a newer writer already updated (optimistic node_id race)", async () => {
    const api = fakeApi([{ id: 7, nodeId: "stale", body: `${STICKY_MARKER}\nold` }], false);
    const out = await upsertStickyComment(api, `${STICKY_MARKER}\nnew`);
    expect(out).toEqual({ action: "skipped_stale", commentId: 7 });
  });

  it("ignores unrelated comments", async () => {
    const api = fakeApi([{ id: 2, nodeId: "x", body: "just a normal comment" }]);
    const out = await upsertStickyComment(api, `${STICKY_MARKER}\nnew`);
    expect(out.action).toBe("created");
  });
});
