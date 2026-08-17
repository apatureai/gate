import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import { canonicalReviewIdentity, type JudgmentEngineClient, type PollOutcome } from "@gate/engine";
import { REVIEW_METRIC_PREFIX, type PublishedReviewFacts } from "@gate/observability";
import { type GateReviewResult, loadMeasuredReviewResult } from "@gate/types";
import type { NormalizedDesignReviewConfig } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import { type ActionRunContext, runAction } from "../src/run.js";

/**
 * The reversal instrument, on the path that publishes.
 *
 * `gate.review.green_over_measured` is the number the measurement decision named
 * as the one that would reverse it, and `GateMetrics` was instantiated nowhere
 * in the product: the counter would have read zero for thirty days and the
 * decision would have been "confirmed" by an instrument that was never plugged
 * in. These tests assert the Action path records it, on a real green-over-
 * measured run and not on a retracted one, and that it does so WITHOUT a caller
 * opting in.
 */

const measured = loadMeasuredReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** A judge that returned one unrelated nit while the DOM measured a WCAG AA failure. */
const greenOverMeasured: GateReviewResult = { ...measured, grade: "ship_with_nits" };

/** The same page, with the engine retracting its own grade. */
const retracted: GateReviewResult = {
  ...measured,
  grade: "ship",
  findings: [],
  gradeUnavailableReason: "measured_facts_unjudged",
};

function ctx(): ActionRunContext {
  return {
    installationId: "acme/web",
    repository: { owner: "acme", name: "web", defaultBranch: "main" },
    pullRequest: { number: 42, headSha: HEAD_SHA, baseSha: "def456", title: "Redesign", body: null },
    isFork: false,
    previewComments: [],
  };
}

function engineReturning(outcome: PollOutcome): JudgmentEngineClient {
  return {
    review: vi.fn(async (reviewCtx) => ({ ...outcome, reviewIdentity: canonicalReviewIdentity(reviewCtx) })),
    cancel: vi.fn(async () => {}),
  };
}

function deps(result: GateReviewResult) {
  const comments: GitHubCommentsApi = {
    listComments: vi.fn(async () => []),
    createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
    updateComment: vi.fn(async () => ({ updated: true })),
  };
  const published: CheckRun[] = [];
  const recorded: PublishedReviewFacts[] = [];
  return {
    engine: engineReturning({ status: "completed", result, jobId: "j" }),
    comments,
    getCurrentHeadSha: vi.fn(async () => HEAD_SHA),
    publishCheckRun: vi.fn(async (run: CheckRun) => void published.push(run)),
    recordMetrics: (facts: PublishedReviewFacts) => void recorded.push(facts),
    _published: published,
    _recorded: recorded,
  };
}

const run = (d: ReturnType<typeof deps>, config: NormalizedDesignReviewConfig = DEFAULT_CONFIG) =>
  runAction(config, { previewUrl: "https://preview.example.com", previewCommand: null }, ctx(), d);

describe("the Action path records the number that would reverse the decision", () => {
  it("counts a green check published over a block-eligible measured violation", async () => {
    const d = deps(greenOverMeasured);
    await run(d);

    expect(d._published[0]?.conclusion).toBe("success");
    expect(d._recorded).toHaveLength(1);
    expect(d._recorded[0]).toMatchObject({
      conclusion: "success",
      graded: true,
      greenOverMeasured: true,
      repository: "acme/web",
      pullRequest: 42,
      headSha: HEAD_SHA,
    });
    expect(d._recorded[0]?.measurementKinds).toEqual(["contrast", "overflow", "touch_target"]);
  });

  it("does not count a run whose grade the engine retracted", async () => {
    const d = deps(retracted);
    await run(d);

    expect(d._published[0]?.conclusion).toBe("neutral");
    expect(d._recorded).toHaveLength(1);
    expect(d._recorded[0]?.greenOverMeasured).toBe(false);
    // Nor in the denominator: a retracted run is not a graded run.
    expect(d._recorded[0]?.graded).toBe(false);
  });

  it("does not count it when the repo muted the measurement", async () => {
    const d = deps(greenOverMeasured);
    await run(d, {
      ...DEFAULT_CONFIG,
      rules: { ...DEFAULT_CONFIG.rules, measurementSuppress: ["#hero-subtitle"] },
    });

    expect(d._published[0]?.conclusion).toBe("success");
    expect(d._recorded[0]?.greenOverMeasured).toBe(false);
    // And says so, so a healthy-looking zero can be told from a muted one.
    expect(d._recorded[0]?.suppressedMeasurementKinds).toEqual(["contrast"]);
  });

  it("records after the check is published, never before", async () => {
    const order: string[] = [];
    const d = deps(greenOverMeasured);
    d.publishCheckRun = vi.fn(async () => void order.push("published"));
    d.recordMetrics = () => void order.push("recorded");

    await run(d);

    expect(order).toEqual(["published", "recorded"]);
  });

  it("records nothing when no review was published at all", async () => {
    const d = deps(greenOverMeasured);
    await runAction(DEFAULT_CONFIG, { previewUrl: null, previewCommand: null }, ctx(), d);

    expect(d._recorded).toHaveLength(0);
  });

  it("records with no caller opting in: the default is the real recorder", async () => {
    // The bug this closes was not a wrong counter, it was a correct counter no
    // production caller ever built. A default that no-ops would reintroduce it
    // while every injected test above kept passing.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const d = deps(greenOverMeasured);
      await run({ ...d, recordMetrics: undefined } as unknown as ReturnType<typeof deps>);

      const lines = info.mock.calls.map((call) => String(call[0])).filter((l) => l.startsWith(REVIEW_METRIC_PREFIX));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("green_over_measured=true");
      expect(lines[0]).toContain("graded=true");
      expect(lines[0]).toContain("repo=acme/web");
    } finally {
      info.mockRestore();
    }
  });
});
