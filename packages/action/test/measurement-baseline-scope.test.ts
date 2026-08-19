import { DEFAULT_CONFIG } from "@gate/config";
import {
  buildMeasurementBaseline,
  createInMemoryMeasurementBaselineStore,
  type CheckRun,
  type GitHubCommentsApi,
  type MeasurementBaselineStore,
} from "@gate/delivery";
import { canonicalReviewIdentity, type JudgmentEngineClient, type PollOutcome } from "@gate/engine";
import {
  loadMeasuredReviewResult,
  type GateReviewResult,
  type NormalizedDesignReviewConfig,
} from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import { type ActionRunContext, runAction } from "../src/run.js";

/**
 * The Action path's baseline story, which is mostly the story of not having one.
 *
 * A GitHub-hosted runner has no database, so the stock Action binds no baseline
 * store. That is the honest state of the world and it is published as such: no
 * baseline, no classification, no gating, said in as many words. The alternative
 * is to treat "I have never looked at your base branch" as "your base branch was
 * clean", which fails somebody's first pull request on their whole back
 * catalogue and gets Gate uninstalled the same afternoon.
 *
 * A self-hosted operator who does have a store gets the App path's behaviour by
 * passing one, which is what the second half of these tests exercises.
 */

const measured = loadMeasuredReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE_SHA = "fedcba9876543210fedcba9876543210fedcba98";

const blockMode: NormalizedDesignReviewConfig = {
  ...DEFAULT_CONFIG,
  rules: { ...DEFAULT_CONFIG.rules, measurements: "block" },
};

function ctx(): ActionRunContext {
  return {
    installationId: "acme/web",
    repository: { owner: "acme", name: "web", defaultBranch: "main" },
    pullRequest: { number: 42, headSha: HEAD_SHA, baseSha: BASE_SHA, title: "Redesign", body: null },
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

function deps(result: GateReviewResult, measurementBaselines?: MeasurementBaselineStore) {
  const comments: GitHubCommentsApi = {
    listComments: vi.fn(async () => []),
    createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
    updateComment: vi.fn(async () => ({ updated: true })),
  };
  const published: CheckRun[] = [];
  return {
    engine: engineReturning({ status: "completed", result, jobId: "j" }),
    comments,
    getCurrentHeadSha: vi.fn(async () => HEAD_SHA),
    publishCheckRun: vi.fn(async (run: CheckRun) => void published.push(run)),
    recordMetrics: () => {},
    ...(measurementBaselines ? { measurementBaselines } : {}),
    _published: published,
  };
}

const run = (d: ReturnType<typeof deps>, config: NormalizedDesignReviewConfig = blockMode) =>
  runAction(config, { previewUrl: "https://preview.example.com", previewCommand: null }, ctx(), d);

describe("the Action path never gates on a violation it cannot attribute", () => {
  it("publishes the measured violations and refuses to fail on them with no store", async () => {
    const d = deps(measured);
    await run(d);

    const check = d._published[0];
    expect(check?.conclusion).not.toBe("failure");
    expect(check?.summary).toContain("#hero-subtitle"); // still reported
    expect(check?.summary).toContain("could not read a stored measurement set");
    expect(check?.summary).toContain("that setting is doing nothing on this run");
  });

  it("does not claim the pull request introduced nothing", async () => {
    // The distinction the whole feature is judged on: "nothing new" and "no way
    // to tell what is new" must not render as the same sentence.
    const d = deps(measured);
    await run(d);

    expect(d._published[0]?.summary).not.toContain("0 introduced by this pull request");
    expect(d._published[0]?.summary).toContain("a statement that Gate does not know");
  });

  it("gates on an introduced violation once an operator binds a store", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    await store.record({
      installationId: "acme/web",
      owner: "acme",
      name: "web",
      commitSha: BASE_SHA,
      snapshot: buildMeasurementBaseline(
        { ...measured, measurements: { checksRun: ["contrast", "overflow", "touch_target"], violations: [] } },
        { commitSha: BASE_SHA },
      ),
    });

    const d = deps(measured, store);
    await run(d);

    expect(d._published[0]?.conclusion).toBe("failure");
    expect(d._published[0]?.summary).toContain("introduced by this pull request");
  });

  it("records the head commit's set for the next run", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    await run(deps(measured, store));

    const stored = await store.find({
      installationId: "acme/web",
      owner: "acme",
      name: "web",
      commitSha: HEAD_SHA,
    });
    expect(stored?.entries).toHaveLength(3);
  });

  it("still publishes when the store throws on both reads and writes", async () => {
    const broken: MeasurementBaselineStore = {
      async record() {
        throw new Error("write failed");
      },
      async find() {
        throw new Error("connection refused");
      },
    };
    const d = deps(measured, broken);
    const outcome = await run(d);

    expect(outcome.status).toBe("reviewed");
    expect(d._published).toHaveLength(1);
    expect(d._published[0]?.conclusion).not.toBe("failure");
  });
});

describe("the Action path states where it rendered, and reads what the base says", () => {
  /**
   * A self-hosted operator with a store gets the App path's behaviour, and that
   * has to include the App path's caution: a baseline measured at the default
   * branch's deployment against a pull request measured at its preview is
   * production compared with a preview, and a difference between those two is
   * not this pull request's doing.
   */
  const cleanBase = (measuredAt?: { surface: "pull_request_preview" | "default_branch"; origin?: string }) =>
    buildMeasurementBaseline(
      { ...measured, measurements: { checksRun: ["contrast", "overflow", "touch_target"], violations: [] } },
      { commitSha: BASE_SHA, ...(measuredAt ? { measuredAt } : {}) },
    );

  it("records the preview it was pointed at with the set it stores", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    await run(deps(measured, store));

    const stored = await store.find({
      installationId: "acme/web",
      owner: "acme",
      name: "web",
      commitSha: HEAD_SHA,
    });
    expect(stored?.measuredAt).toEqual({
      surface: "pull_request_preview",
      origin: "https://preview.example.com",
    });
  });

  it("still fails on an introduced violation when the base was a preview too", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    await store.record({
      installationId: "acme/web",
      owner: "acme",
      name: "web",
      commitSha: BASE_SHA,
      snapshot: cleanBase({ surface: "pull_request_preview", origin: "https://main.example.com" }),
    });

    const d = deps(measured, store);
    await run(d);

    expect(d._published[0]?.conclusion).toBe("failure");
  });

  it("does not fail when the base was measured at the default branch's deployment", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    await store.record({
      installationId: "acme/web",
      owner: "acme",
      name: "web",
      commitSha: BASE_SHA,
      snapshot: cleanBase({ surface: "default_branch", origin: "https://app.example.com" }),
    });

    const d = deps(measured, store);
    await run(d);

    expect(d._published[0]?.conclusion).not.toBe("failure");
    expect(d._published[0]?.summary).toContain("rendered by different deployments");
  });
});
