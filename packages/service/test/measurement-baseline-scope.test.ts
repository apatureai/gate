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
import { type HostedReviewContext, runHostedReview } from "../src/hosted-review.js";
import { createInMemoryFullReviewWindow } from "../src/review-window.js";
import { createInMemorySupersessionStore, recordEnqueue } from "../src/supersession.js";

/**
 * The App path, end to end, on the question that decides whether a merge gate
 * survives contact with a real repository: is this violation this pull request's
 * fault?
 *
 * The measured fixture carries three violations, one of them block-eligible.
 * Under `rules.measurements: block` the pre-scoping behaviour was to fail the
 * check on all of them from the first run, which on a mature repository means
 * failing the first pull request after installation on a back catalogue nobody
 * in the pull request touched.
 */

const measured = loadMeasuredReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE_SHA = "fedcba9876543210fedcba9876543210fedcba98";

const blockMode: NormalizedDesignReviewConfig = {
  ...DEFAULT_CONFIG,
  rules: { ...DEFAULT_CONFIG.rules, measurements: "block" },
};

const ctx: HostedReviewContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  pullRequest: { number: 42, headSha: HEAD_SHA, baseSha: BASE_SHA, title: "Redesign", body: null },
  isFork: false,
  preview: { url: "https://acme.vercel.app", provider: "vercel", source: "deployment_status" },
};

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
    supersession: createInMemorySupersessionStore(),
    windowStore: createInMemoryFullReviewWindow(),
    engine: engineReturning({ status: "completed", result, jobId: "j" }),
    comments,
    publishCheckRun: vi.fn(async (r: CheckRun) => void published.push(r)),
    recordMetrics: () => {},
    ...(measurementBaselines ? { measurementBaselines } : {}),
    _published: published,
    _comments: comments,
  };
}

async function run(d: ReturnType<typeof deps>, config = blockMode) {
  await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, HEAD_SHA);
  return runHostedReview(config, ctx, d);
}

describe("the App path scopes gating to what the pull request introduced", () => {
  it("refuses to fail the first pull request, and says it has no baseline", async () => {
    // THE case. A repository installs Gate, turns on `block`, and opens a pull
    // request. Gate has never measured the base, so it cannot show that any of
    // these three violations are new, and it does not pretend otherwise.
    const store = createInMemoryMeasurementBaselineStore();
    const d = deps(measured, store);
    await run(d);

    const check = d._published[0];
    expect(check?.conclusion).not.toBe("failure");
    expect(check?.summary).toContain("no baseline");
    expect(check?.summary).toContain("Gate has never recorded a measurement set");
    expect(check?.summary).toContain("that setting is doing nothing on this run");
  });

  it("records the head commit's set, so the next pull request has a base to use", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    await run(deps(measured, store));

    const stored = await store.find({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: HEAD_SHA,
    });
    expect(stored).not.toBeNull();
    expect(stored?.entries).toHaveLength(measured.measurements?.violations.length ?? 0);
    expect(stored?.commitSha).toBe(HEAD_SHA);
  });

  it("fails the check once the base is on record and the pull request adds a violation", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    // The base branch was reviewed and was clean.
    const cleanBase: GateReviewResult = {
      ...measured,
      measurements: { checksRun: measured.measurements?.checksRun ?? [], violations: [] },
    };
    await store.record({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: BASE_SHA,
      snapshot: buildMeasurementBaseline(cleanBase, { commitSha: BASE_SHA }),
    });

    const d = deps(measured, store);
    await run(d);

    const check = d._published[0];
    expect(check?.conclusion).toBe("failure");
    expect(check?.title).toBe("Measured violations");
    expect(check?.summary).toContain("introduced by this pull request");
  });

  it("passes the check when every violation was already on the base", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    await store.record({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: BASE_SHA,
      snapshot: buildMeasurementBaseline(measured, { commitSha: BASE_SHA }),
    });

    const d = deps(measured, store);
    await run(d);

    const check = d._published[0];
    expect(check?.conclusion).not.toBe("failure");
    expect(check?.summary).toContain("0 introduced by this pull request");
    expect(check?.summary).toContain("Already on the base");
    // Still reported, never hidden: the violations are on the surface either way.
    expect(check?.summary).toContain("#hero-subtitle");
  });

  it("says 'cannot classify' rather than 'clean' when no store is bound at all", async () => {
    const d = deps(measured); // no measurementBaselines dep
    await run(d);

    const check = d._published[0];
    expect(check?.conclusion).not.toBe("failure");
    expect(check?.summary).toContain("could not read a stored measurement set");
    expect(check?.summary).toContain("no baseline store is configured");
  });

  it("puts the same scoping in the sticky comment as on the check", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    const d = deps(measured, store);
    await run(d);

    const created = vi.mocked(d._comments.createComment).mock.calls[0]?.[0] ?? "";
    expect(created).toContain("no baseline");
    expect(d._published[0]?.summary).toContain("no baseline");
  });

  it("publishes the review even when the baseline store is broken", async () => {
    // A baseline is not on the critical path of publishing a review. A database
    // that is down costs the run its scoping, never its Check Run.
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

    expect(outcome.status).toBe("published");
    expect(d._published).toHaveLength(1);
    expect(d._published[0]?.conclusion).not.toBe("failure");
    expect(d._published[0]?.summary).toContain("could not read a stored measurement set");
  });
});

describe("the App path refuses to blame a pull request for the deployment it was compared against", () => {
  /**
   * THE LAST WAY THIS FEATURE COULD BE WORSE THAN THE PROBLEM. A baseline
   * recorded by a push is measured at `preview.default_branch_url`, which for
   * most teams is production; this pull request is measured at its own preview.
   * Seed data, feature flags, a signed-out state or a consent banner then
   * produce a violation on one side and not the other, and under `block` that
   * used to read as introduced and fail a build nobody broke.
   *
   * The pair below is the whole claim: the same review, the same violations, the
   * same store, and the only thing that differs is WHERE the stored set was
   * rendered.
   */
  const cleanBase: GateReviewResult = {
    ...measured,
    measurements: { checksRun: measured.measurements?.checksRun ?? [], violations: [] },
  };

  async function runAgainstBase(measuredAt: { surface: "pull_request_preview" | "default_branch"; origin?: string }) {
    const store = createInMemoryMeasurementBaselineStore();
    await store.record({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: BASE_SHA,
      snapshot: buildMeasurementBaseline(cleanBase, { commitSha: BASE_SHA, measuredAt }),
    });
    const d = deps(measured, store);
    await run(d);
    return d._published[0];
  }

  it("fails the check when the base was measured at a preview, as it always did", async () => {
    // The control, and the thing that must never stop working: an ordinary team
    // whose baseline came from a review or from a merge carry-forward.
    const check = await runAgainstBase({
      surface: "pull_request_preview",
      origin: "https://acme-git-main.vercel.app",
    });

    expect(check?.conclusion).toBe("failure");
    expect(check?.summary).toContain("introduced by this pull request");
  });

  it("does not fail the check when the base was measured at the default branch's deployment", async () => {
    const check = await runAgainstBase({ surface: "default_branch", origin: "https://app.example.com" });

    expect(check?.conclusion).not.toBe("failure");
    expect(check?.summary).toContain("not classified");
    expect(check?.summary).toContain("rendered by different deployments");
    // And it does not read as a clean pull request: the reason is on the surface.
    expect(check?.summary).toContain("cannot be attributed");
  });

  it("fails it again once the repository declares the two render alike", async () => {
    // The escape hatch, and the reason this is a declaration rather than an
    // inference: the URL is opaque, so a staging deployment built like a preview
    // and production are the same string to Gate.
    const store = createInMemoryMeasurementBaselineStore();
    await store.record({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: BASE_SHA,
      snapshot: buildMeasurementBaseline(cleanBase, {
        commitSha: BASE_SHA,
        measuredAt: { surface: "default_branch", origin: "https://staging.example.com" },
      }),
    });
    const d = deps(measured, store);
    await run(d, {
      ...blockMode,
      preview: { ...blockMode.preview, defaultBranchRendersLikePreview: true },
    });

    expect(d._published[0]?.conclusion).toBe("failure");
    expect(d._published[0]?.summary).toContain("introduced by this pull request");
  });

  it("records this run's own preview address with the set it stores", async () => {
    // Which is what makes the NEXT pull request's comparison answerable at all.
    const store = createInMemoryMeasurementBaselineStore();
    await run(deps(measured, store));

    const stored = await store.find({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: HEAD_SHA,
    });
    expect(stored?.measuredAt).toEqual({
      surface: "pull_request_preview",
      origin: "https://acme.vercel.app",
    });
  });
});
