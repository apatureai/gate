import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import { canonicalReviewIdentity, type JudgmentEngineClient, type PollOutcome } from "@gate/engine";
import { REVIEW_METRIC_PREFIX, type PublishedReviewFacts } from "@gate/observability";
import { type GateReviewResult, loadMeasuredReviewResult } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import { type HostedReviewContext, runHostedReview } from "../src/hosted-review.js";
import { createInMemoryFullReviewWindow } from "../src/review-window.js";
import { createInMemorySupersessionStore, recordEnqueue } from "../src/supersession.js";

/**
 * The App path's half of the reversal instrument.
 *
 * The hosted service publishes the same Check Run from the same delivery
 * decision, so it has to record the same number. Recording it on only one of the
 * two paths would answer "how often does Gate publish green over a measured
 * violation" with data from whichever path the reader happened to be on.
 */

const measured = loadMeasuredReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const greenOverMeasured: GateReviewResult = { ...measured, grade: "ship_with_nits" };
const retracted: GateReviewResult = {
  ...measured,
  grade: "ship",
  findings: [],
  gradeUnavailableReason: "measured_facts_unjudged",
};

const ctx: HostedReviewContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  pullRequest: { number: 42, headSha: HEAD_SHA, baseSha: "def", title: "Redesign", body: null },
  isFork: false,
  preview: { url: "https://acme.vercel.app", provider: "vercel", source: "deployment_status" },
};

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
    supersession: createInMemorySupersessionStore(),
    windowStore: createInMemoryFullReviewWindow(),
    engine: engineReturning({ status: "completed", result, jobId: "j" }),
    comments,
    publishCheckRun: vi.fn(async (r: CheckRun) => void published.push(r)),
    recordMetrics: (facts: PublishedReviewFacts) => void recorded.push(facts),
    _published: published,
    _recorded: recorded,
  };
}

async function run(d: ReturnType<typeof deps>) {
  await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, HEAD_SHA);
  return runHostedReview(DEFAULT_CONFIG, ctx, d);
}

describe("the App path records the number that would reverse the decision", () => {
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
  });

  it("does not count a run whose grade the engine retracted", async () => {
    const d = deps(retracted);
    await run(d);

    expect(d._published[0]?.conclusion).toBe("neutral");
    expect(d._recorded[0]?.greenOverMeasured).toBe(false);
    expect(d._recorded[0]?.graded).toBe(false);
  });

  it("records nothing for a stale result the publish guard discarded", async () => {
    const d = deps(greenOverMeasured);
    await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, "newer-sha");

    const out = await runHostedReview(DEFAULT_CONFIG, ctx, d);

    expect(out.status).toBe("stale_discarded");
    expect(d._recorded).toHaveLength(0);
  });

  it("records with no caller opting in: the default is the real recorder", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const d = deps(greenOverMeasured);
      await run({ ...d, recordMetrics: undefined } as unknown as ReturnType<typeof deps>);

      const lines = info.mock.calls.map((call) => String(call[0])).filter((l) => l.startsWith(REVIEW_METRIC_PREFIX));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("green_over_measured=true");
      expect(lines[0]).toContain("repo=acme/web");
      expect(lines[0]).toContain("pr=42");
    } finally {
      info.mockRestore();
    }
  });
});
