import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STICKY_MARKER } from "@gate/delivery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatReviewDemoResult, renderFixturePage, runReviewDemo, type ReviewDemoResult } from "../src/index.js";

/**
 * The review demo is documented in the README as the thing a reader runs, so its
 * artifacts are asserted here: a stranger following the README must get the
 * comment, the Check Run and the annotated PNGs, not a stack trace.
 */
describe("runReviewDemo", () => {
  let outDir: string;
  let result: ReviewDemoResult;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "gate-review-demo-"));
    result = await runReviewDemo({ outDir });
  }, 60_000);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("runs the Action path to a published review", () => {
    expect(result.outcome.status).toBe("reviewed");
    expect(result.outcome.commentAction).toBe("created");
    expect(result.grade).toBe("needs_work");
    expect(result.findingCount).toBe(3);
  });

  it("maps a needs_work grade to an advisory (never failing) Check Run", () => {
    expect(result.checkRun.conclusion).toBe("neutral");
    expect(result.checkRun.title).toBe("Needs work");
  });

  it("writes the sticky comment with the marker, the findings and the evidence links", async () => {
    const comment = await readFile(result.commentPath, "utf8");
    expect(comment).toContain(STICKY_MARKER);
    expect(comment).toContain("Primary CTA uses an off-brand color on mobile");
    expect(comment).toContain("[Evidence](./annotated-f_001.png)");
  });

  it("writes an annotated PNG per finding that has recorded geometry", async () => {
    expect(result.screenshots.map((s) => s.findingId)).toEqual(["f_001", "f_002"]);
    for (const shot of result.screenshots) {
      const bytes = await readFile(shot.path);
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // PNG magic
      expect(bytes.byteLength).toBeGreaterThan(1_000);
    }
  });

  it("annotates the fixture page rather than an empty canvas", async () => {
    const { default: sharp } = await import("sharp");
    const base = await renderFixturePage();
    const meta = await sharp(base).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 390, height: 844 });

    const annotated = await readFile(result.screenshots[0]!.path);
    // The box is composited on top, so the annotated PNG differs from the base.
    expect(annotated.equals(base)).toBe(false);
  });
});

describe("formatReviewDemoResult", () => {
  it("names every artifact it wrote, relative to the working directory", () => {
    const text = formatReviewDemoResult(
      {
        outDir: "/repo/out",
        outcome: { status: "reviewed", conclusion: "neutral", commentAction: "created" },
        grade: "needs_work",
        findingCount: 3,
        notReviewed: ["route /checkout"],
        commentPath: "/repo/out/review-comment.md",
        commentBytes: 1186,
        checkRunPath: "/repo/out/check-run.json",
        checkRun: { name: "Apature Gate", conclusion: "neutral", title: "Needs work", summary: "" },
        screenshots: [{ findingId: "f_001", path: "/repo/out/annotated-f_001.png", bytes: 26154 }],
      },
      "/repo",
    );
    expect(text).toContain("./out/review-comment.md");
    expect(text).toContain("./out/annotated-f_001.png");
    expect(text).toContain("needs_work · 3 findings");
    expect(text).toContain("check run       neutral — Needs work");
  });
});
