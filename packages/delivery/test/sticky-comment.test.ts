import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import {
  findingsAtOrAbove,
  type GitHubCommentsApi,
  type IssueComment,
  renderStickyComment,
  STICKY_MARKER,
  suppressFindings,
  upsertStickyComment,
} from "../src/index.js";

const golden = loadGoldenReviewResult();
const ZWSP = String.fromCharCode(0x200b);

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

  it("links annotated screenshot evidence from collapsed finding rows", () => {
    expect(body).toContain(
      `[Evidence](${golden.artifacts.annotatedScreenshots[0]!.url})`,
    );
    expect(body).toContain(
      `[Evidence](${golden.artifacts.annotatedScreenshots[1]!.url})`,
    );
  });

  it("does not render a broken evidence placeholder for findings without screenshots", () => {
    const out = renderStickyComment(golden, { headSha: "abc1234" });
    expect(out).toContain("Inconsistent vertical rhythm");
    expect(out).not.toContain("f_003");
    expect(out).not.toContain("[Evidence]()");
  });

  it("renders the not-reviewed section (never silently dropped)", () => {
    expect(body).toContain("### Not reviewed");
    // Engine prose, so it arrives sanitized: same line, with the Markdown
    // metacharacters escaped (GFM renders `\(` as a literal `(`).
    expect(body).toContain("route /checkout \\(no preview deployment matched the head SHA\\)");
  });

  it("includes a page-health footnote with engine/model/ui-dna lineage", () => {
    expect(body).toContain(`model ${golden.metadata.model}`);
    // The stamps are engine-supplied too: `@` is defanged with a zero-width
    // space, which is invisible to a reader and inert to GitHub's mention parser.
    expect(body).toContain(`ui-dna ui-dna@${ZWSP}2026.06.12`);
    expect(body).toContain("[run details](https://gate.app/r/1)");
  });

  it("renders a blockers table when blockers exist", () => {
    const withBlocker = {
      ...golden,
      findings: [{ ...golden.findings[0]!, severity: "blocker" as const, title: "Contrast fails WCAG" }],
    };
    const out = renderStickyComment(withBlocker, { headSha: "abc1234" });
    expect(out).toContain("### ⛔ Blockers");
    expect(out).toContain("| Finding | Route | Viewport | Suggestion | Evidence |");
    expect(out).toContain("Contrast fails WCAG");
    expect(out).toContain(`[Evidence](${golden.artifacts.annotatedScreenshots[0]!.url})`);
  });

  it("surfaces a capture caveat when provided", () => {
    const out = renderStickyComment(golden, { headSha: "abc1234", captureCaveat: "Capture was unstable on 1 route." });
    expect(out).toContain("Capture was unstable");
  });

  it("applies min_severity_to_comment: omits findings below the threshold", () => {
    // golden has one major, one minor, one nit finding.
    const out = renderStickyComment(golden, { headSha: "abc1234", minSeverityToComment: "major" });
    expect(out).toContain("Primary CTA uses an off-brand color"); // major, kept (in Should fix)
    expect(out).toContain("Should fix (1)"); // the major finding still lives here
    expect(out).not.toContain("Pricing card grid overflows"); // minor, omitted
    expect(out).not.toContain(golden.artifacts.annotatedScreenshots[1]!.url); // omitted finding's evidence
    expect(out).not.toContain("Inconsistent vertical rhythm"); // nit, omitted
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

  it("applies rules.suppress: omits findings whose element or id matches", () => {
    // Suppress the minor finding by its element selector and the nit by its id.
    const out = renderStickyComment(golden, {
      headSha: "abc1234",
      suppress: [".pricing-grid", "f_003"],
    });
    expect(out).toContain("Primary CTA uses an off-brand color"); // major, kept
    expect(out).not.toContain("Pricing card grid overflows"); // suppressed by element
    expect(out).not.toContain(golden.artifacts.annotatedScreenshots[1]!.url); // suppressed evidence omitted
    expect(out).not.toContain("Inconsistent vertical rhythm"); // suppressed by id
    expect(out).not.toContain("Nits ("); // nits section empties out
  });

  it("still renders the grade even when suppression empties the list", () => {
    const out = renderStickyComment(golden, {
      headSha: "abc1234",
      suppress: ["f_001", "f_002", "f_003"],
    });
    expect(out).toContain("Needs work"); // grade reflects the engine verdict, not the filter
    expect(out).not.toContain("Should fix (");
    expect(out).not.toContain("Nits (");
  });

  it("an unset suppress list lists everything (backward-compatible)", () => {
    const out = renderStickyComment(golden, { headSha: "abc1234", suppress: [] });
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

describe("suppressFindings", () => {
  it("drops findings whose element selector matches an entry", () => {
    const keep = suppressFindings(golden.findings, [".pricing-grid"]);
    expect(keep.map((f) => f.id)).toEqual(["f_001", "f_003"]);
  });

  it("drops findings whose stable id matches an entry", () => {
    const keep = suppressFindings(golden.findings, ["f_001"]);
    expect(keep.map((f) => f.id)).toEqual(["f_002", "f_003"]);
  });

  it("matches exactly — a partial/substring entry suppresses nothing", () => {
    expect(suppressFindings(golden.findings, ["pricing", "f_00"])).toHaveLength(golden.findings.length);
  });

  it("defaults to keeping everything when the list is empty or unset", () => {
    expect(suppressFindings(golden.findings, [])).toHaveLength(golden.findings.length);
    expect(suppressFindings(golden.findings)).toHaveLength(golden.findings.length);
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
