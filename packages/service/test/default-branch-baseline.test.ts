import { DEFAULT_CONFIG } from "@gate/config";
import {
  buildMeasurementBaseline,
  createInMemoryMeasurementBaselineStore,
  MEASUREMENT_IDENTITY_VERSION,
  type MeasurementBaselineSnapshot,
  type MeasurementBaselineStore,
} from "@gate/delivery";
import type { JudgmentEngineClient, MeasurementProbe } from "@gate/engine";
import type {
  GateMeasurementRequest,
  GateMeasurementResult,
  NormalizedDesignReviewConfig,
} from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app.js";
import {
  fillDefaultBranchUrl,
  parseDefaultBranchPush,
  recordDefaultBranchBaseline,
  type DefaultBranchBaselineDeps,
} from "../src/default-branch-baseline.js";
import { createAppWebhookHandlers } from "../src/hosted-review.js";
import { createInMemorySupersessionStore } from "../src/supersession.js";
import { createInMemoryReviewWorker } from "../src/worker.js";

/**
 * Reviewing the default branch: the only mechanism that gives EVERY merge, under
 * every strategy and after every race, a base a later pull request can be scoped
 * against.
 *
 * The merge carry-forward before it copies a measured set onto a merge commit
 * when the trees are identical, which holds exactly while the base has not
 * moved. A busy repository moves its base constantly, so every merge that raced
 * another landing carried nothing and the gate went quiet on precisely those
 * merges. A push to the default branch is the event that does not have that
 * hole: whatever strategy produced the commit, it arrives here.
 *
 * WHAT MAKES IT AFFORDABLE IS THE POINT OF THE WHOLE FEATURE, so most of what
 * follows is about what a push must NOT do. It must not call a model. It must not
 * publish a Check Run, a comment, or anything else a person could read as a
 * judgment. It must not fire on a branch that is not the default one, on a tag,
 * or on a deletion. And it must cost nothing when it fails.
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ZERO = "0".repeat(40);

/** A measure-only result: measured facts, coverage, no grade and no findings. */
function measured(over: Partial<GateMeasurementResult> = {}): GateMeasurementResult {
  return {
    measurements: {
      checksRun: ["contrast", "overflow"],
      violations: [
        {
          kind: "contrast",
          route: "/",
          viewports: ["mobile"],
          element: "#hero .tagline",
          detail: "Contrast 2.91:1 against #f4f4f5, below the 4.5:1 minimum",
          blockEligible: true,
          severity: 2,
        },
      ],
    },
    coverage: {
      routesRequested: ["/", "/pricing"],
      routesReviewed: ["/", "/pricing"],
      viewportsRequested: ["mobile", "desktop"],
      viewportsReviewed: ["mobile", "desktop"],
    },
    metadata: { engineVersion: "verdict@9.9.9", captureVersion: "capture@2" },
    ...over,
  };
}

/** A probe that records what it was asked and answers with a fixed measurement. */
function probeReturning(result: GateMeasurementResult = measured()): MeasurementProbe & {
  requests: GateMeasurementRequest[];
} {
  const requests: GateMeasurementRequest[] = [];
  return {
    requests,
    async measure(request) {
      requests.push(request);
      return result;
    },
  };
}

/**
 * The model client, wired so that touching it is a test failure.
 *
 * "A push never spends a model call" is the claim the economics of this feature
 * rest on, and the only way to test a negative is to make the forbidden call
 * throw. Every path below that reaches the webhook handlers gets this one.
 */
function engineThatMustNotBeCalled(): JudgmentEngineClient {
  return {
    review() {
      throw new Error("a push must never call the judgment engine: that is a model call");
    },
    cancel() {
      throw new Error("a push must never call the judgment engine: that is a model call");
    },
  };
}

function configWith(
  over: Partial<NormalizedDesignReviewConfig["preview"]>,
): NormalizedDesignReviewConfig {
  return { ...DEFAULT_CONFIG, preview: { ...DEFAULT_CONFIG.preview, ...over } };
}

const DEPLOYED = configWith({ defaultBranchUrl: "https://app.example.com" });

function pushPayload(over: Record<string, unknown> = {}): unknown {
  return {
    ref: "refs/heads/main",
    before: "1111111111111111111111111111111111111111",
    after: COMMIT,
    created: false,
    deleted: false,
    forced: false,
    installation: { id: 7 },
    repository: { name: "web", owner: { login: "acme" }, default_branch: "main" },
    ...over,
  };
}

function deps(over: Partial<DefaultBranchBaselineDeps> = {}): DefaultBranchBaselineDeps & {
  measurementBaselines: MeasurementBaselineStore;
} {
  return {
    measurementBaselines: createInMemoryMeasurementBaselineStore(),
    measure: probeReturning(),
    loadConfig: async () => DEPLOYED,
    now: () => 4_000,
    ...over,
  } as DefaultBranchBaselineDeps & { measurementBaselines: MeasurementBaselineStore };
}

const findBaseline = (
  store: MeasurementBaselineStore,
  commitSha = COMMIT,
): Promise<MeasurementBaselineSnapshot | null> =>
  store.find({ installationId: "7", owner: "acme", name: "web", commitSha });

describe("recordDefaultBranchBaseline: a push to the default branch records a set", () => {
  it("measures the pushed commit and stores its baseline", async () => {
    const d = deps();
    const outcome = await recordDefaultBranchBaseline(pushPayload(), d);

    expect(outcome).toEqual({ status: "recorded", commitSha: COMMIT, checksRun: 2, entries: 1 });

    const stored = await findBaseline(d.measurementBaselines);
    expect(stored).not.toBeNull();
    expect(stored?.commitSha).toBe(COMMIT);
    expect(stored?.checksRun).toEqual(["contrast", "overflow"]);
    expect(stored?.routesMeasured).toEqual(["/", "/pricing"]);
    expect(stored?.viewportsMeasured).toEqual(["desktop", "mobile"]);
    expect(stored?.entries).toHaveLength(1);
    expect(stored?.recordedAtMs).toBe(4_000);
    // The set is OBSERVED here, not carried: this commit was actually rendered.
    expect(stored?.carriedFrom).toBeUndefined();
    // Same identity version a review's set is stamped with, so a pull request
    // scoped against this one is not refused for skew.
    expect(stored?.version).toBe(MEASUREMENT_IDENTITY_VERSION);
    expect(stored?.engineVersion).toBe("verdict@9.9.9");
  });

  it("reads the default branch from the payload rather than assuming main", async () => {
    const d = deps();
    const outcome = await recordDefaultBranchBaseline(
      pushPayload({
        ref: "refs/heads/trunk",
        repository: { name: "web", owner: { login: "acme" }, default_branch: "trunk" },
      }),
      d,
    );

    expect(outcome.status).toBe("recorded");
    expect(await findBaseline(d.measurementBaselines)).not.toBeNull();
  });

  it("hands the capture the commit, the resolved URL and the repository's own config", async () => {
    const probe = probeReturning();
    const config = configWith({
      defaultBranchUrl: "https://{short_sha}.app.example.com/{sha}",
      environment: "Production",
    });
    await recordDefaultBranchBaseline(pushPayload(), deps({ measure: probe, loadConfig: async () => config }));

    expect(probe.requests).toHaveLength(1);
    const request = probe.requests[0]!;
    expect(request.commitSha).toBe(COMMIT);
    expect(request.repository).toEqual({ owner: "acme", name: "web", defaultBranch: "main" });
    expect(request.installationId).toBe("7");
    expect(request.preview.url).toBe(`https://0123456.app.example.com/${COMMIT}`);
    expect(request.preview.environment).toBe("Production");
    // The routes and viewports a baseline is measured over must be the ones the
    // next pull request is measured over, or the two runs answer different
    // questions and the comparison between them means nothing.
    expect(request.config.routes).toEqual(config.routes);
    expect(request.config.viewports).toEqual(config.viewports);
  });

  it("records a commit that a force push landed, because a set is a fact about a commit", async () => {
    const d = deps();
    const outcome = await recordDefaultBranchBaseline(pushPayload({ forced: true }), d);

    expect(outcome.status).toBe("recorded");
    expect(await findBaseline(d.measurementBaselines)).not.toBeNull();
  });

  it("leaves a set stored for a commit a force push orphaned exactly where it is", async () => {
    // A stored set says "this tree, measured, produced these violations". Moving
    // the branch does not make that false about the commit it names, so nothing
    // already recorded is invalidated and a pull request whose base is that
    // commit is still scoped correctly.
    const d = deps();
    await recordDefaultBranchBaseline(pushPayload(), d);
    const orphaned = "cafebabecafebabecafebabecafebabecafebabe";
    await recordDefaultBranchBaseline(pushPayload({ after: orphaned, forced: true }), d);

    expect(await findBaseline(d.measurementBaselines, COMMIT)).not.toBeNull();
    expect(await findBaseline(d.measurementBaselines, orphaned)).not.toBeNull();
  });
});

describe("recordDefaultBranchBaseline: everything that must record nothing", () => {
  it("records nothing for a push to a branch that is not the default one", async () => {
    const d = deps();
    const outcome = await recordDefaultBranchBaseline(
      pushPayload({ ref: "refs/heads/feature/login" }),
      d,
    );

    expect(outcome).toEqual({ status: "not_default_branch", ref: "refs/heads/feature/login" });
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("records nothing for a branch whose NAME contains the default branch's", async () => {
    // `refs/heads/main-rewrite` shares a prefix with `refs/heads/main`. A
    // startsWith comparison would measure it and file the result as the default
    // branch's baseline.
    const d = deps();
    const outcome = await recordDefaultBranchBaseline(
      pushPayload({ ref: "refs/heads/main-rewrite" }),
      d,
    );

    expect(outcome.status).toBe("not_default_branch");
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("records nothing for a tag push, even though the tag names a default-branch commit", async () => {
    const d = deps();
    const outcome = await recordDefaultBranchBaseline(pushPayload({ ref: "refs/tags/v1.4.0" }), d);

    expect(outcome).toEqual({ status: "not_default_branch", ref: "refs/tags/v1.4.0" });
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("records nothing for a merge queue's staging ref", async () => {
    const d = deps();
    const outcome = await recordDefaultBranchBaseline(
      pushPayload({ ref: "refs/heads/gh-readonly-queue/main/pr-42-abc123" }),
      d,
    );

    expect(outcome.status).toBe("not_default_branch");
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("records nothing when the branch was deleted", async () => {
    const d = deps();
    const outcome = await recordDefaultBranchBaseline(
      pushPayload({ deleted: true, after: ZERO }),
      d,
    );

    expect(outcome).toEqual({ status: "branch_deleted", ref: "refs/heads/main" });
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("records nothing when `deleted` says so, even if a real sha survived in `after`", async () => {
    // The distinguishing payload for the `deleted` guard: GitHub normally zeroes
    // `after` on a deletion, so a handler that read only the sha would look
    // correct against every ordinary delivery and would measure a commit on the
    // one delivery where the two fields disagree. Both are read for that reason.
    const d = deps();
    const outcome = await recordDefaultBranchBaseline(
      pushPayload({ deleted: true, after: COMMIT }),
      d,
    );

    expect(outcome).toEqual({ status: "branch_deleted", ref: "refs/heads/main" });
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("records nothing for a zero after-sha even when `deleted` is missing", async () => {
    // Either field alone is a single value standing between a commit that does
    // not exist and the baseline store, so both are checked.
    const d = deps({ measure: probeReturning() });
    const outcome = await recordDefaultBranchBaseline(pushPayload({ after: ZERO, deleted: undefined }), d);

    expect(outcome).toEqual({ status: "branch_deleted", ref: "refs/heads/main" });
    expect(await findBaseline(d.measurementBaselines, ZERO)).toBeNull();
  });

  it("never measures anything it will not record", async () => {
    const probe = probeReturning();
    const d = deps({ measure: probe });
    await recordDefaultBranchBaseline(pushPayload({ ref: "refs/tags/v1" }), d);
    await recordDefaultBranchBaseline(pushPayload({ ref: "refs/heads/feature" }), d);
    await recordDefaultBranchBaseline(pushPayload({ deleted: true, after: ZERO }), d);

    // A capture costs a browser, a sandbox and a minute. A ref that records
    // nothing must not pay for one.
    expect(probe.requests).toHaveLength(0);
  });

  it("records nothing when the payload is missing the installation", async () => {
    const d = deps();
    const outcome = await recordDefaultBranchBaseline(pushPayload({ installation: undefined }), d);

    expect(outcome).toEqual({ status: "skipped", reason: "incomplete_event" });
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("records nothing when the repository does not say where its default branch is deployed", async () => {
    const probe = probeReturning();
    const d = deps({ measure: probe, loadConfig: async () => DEFAULT_CONFIG });
    const outcome = await recordDefaultBranchBaseline(pushPayload(), d);

    expect(outcome).toEqual({ status: "skipped", reason: "no_default_branch_url" });
    expect(probe.requests).toHaveLength(0);
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("records nothing when no measure probe is bound, and never falls back to a review", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    const outcome = await recordDefaultBranchBaseline(pushPayload(), {
      measurementBaselines: store,
      loadConfig: async () => DEPLOYED,
    });

    expect(outcome).toEqual({ status: "skipped", reason: "not_configured" });
    expect(await findBaseline(store)).toBeNull();
  });

  it("records nothing when no baseline store is bound", async () => {
    const probe = probeReturning();
    const outcome = await recordDefaultBranchBaseline(pushPayload(), {
      measure: probe,
      loadConfig: async () => DEPLOYED,
    });

    expect(outcome).toEqual({ status: "skipped", reason: "not_configured" });
    expect(probe.requests).toHaveLength(0);
  });

  it("refuses a configured URL that is not an http(s) address", async () => {
    const probe = probeReturning();
    const d = deps({
      measure: probe,
      loadConfig: async () => configWith({ defaultBranchUrl: "file:///etc/passwd" }),
    });
    const outcome = await recordDefaultBranchBaseline(pushPayload(), d);

    expect(outcome.status).toBe("unverified_url");
    expect(probe.requests).toHaveLength(0);
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });
});

describe("recordDefaultBranchBaseline: a failure costs the next scoping and nothing else", () => {
  it("does not let a store that throws escape", async () => {
    const store: MeasurementBaselineStore = {
      async record() {
        throw new Error("baselines table is unavailable");
      },
      async find() {
        return null;
      },
    };
    const outcome = await recordDefaultBranchBaseline(pushPayload(), deps({ measurementBaselines: store }));

    expect(outcome).toEqual({ status: "failed", detail: "baselines table is unavailable" });
  });

  it("does not let a measure call that throws escape", async () => {
    const d = deps({
      measure: {
        async measure() {
          throw new Error("measure submit failed: 404 (not_found)");
        },
      },
    });
    const outcome = await recordDefaultBranchBaseline(pushPayload(), d);

    expect(outcome).toEqual({ status: "failed", detail: "measure submit failed: 404 (not_found)" });
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("does not let a config read that throws escape", async () => {
    const d = deps({
      loadConfig: async () => {
        throw new Error("could not read .gate.yml");
      },
    });
    const outcome = await recordDefaultBranchBaseline(pushPayload(), d);

    expect(outcome).toEqual({ status: "failed", detail: "could not read .gate.yml" });
  });

  it("never retries a failure", async () => {
    const measure = vi.fn(async () => {
      throw new Error("engine is down");
    });
    await recordDefaultBranchBaseline(pushPayload(), deps({ measure: { measure } }));

    // One push, one attempt. A retry here would multiply every failing push on a
    // busy default branch into a stampede against an engine already failing.
    expect(measure).toHaveBeenCalledTimes(1);
  });
});

describe("parseDefaultBranchPush", () => {
  it("reports a non-push payload as not the default branch", () => {
    expect(parseDefaultBranchPush(null).kind).toBe("not_default_branch");
    expect(parseDefaultBranchPush("push").kind).toBe("not_default_branch");
    expect(parseDefaultBranchPush({}).kind).toBe("not_default_branch");
  });

  it("does nothing when the payload does not say what the default branch is", () => {
    // Guessing `main` here is how a repository on `master` gets a silent gate
    // that looks exactly like a working one.
    expect(
      parseDefaultBranchPush({ ref: "refs/heads/main", repository: { name: "web" } }).kind,
    ).toBe("not_default_branch");
  });
});

describe("fillDefaultBranchUrl", () => {
  it("substitutes the pushed commit", () => {
    expect(fillDefaultBranchUrl("https://x.dev/{sha}/{short_sha}", COMMIT)).toBe(
      `https://x.dev/${COMMIT}/0123456`,
    );
  });

  it("leaves a URL with no placeholder alone", () => {
    expect(fillDefaultBranchUrl("https://app.example.com", COMMIT)).toBe("https://app.example.com");
  });
});

describe("the push handler publishes nothing and calls no model", () => {
  /** The App webhook handlers, with every publishing surface wired to explode. */
  function handlers(over: Partial<DefaultBranchBaselineDeps> = {}) {
    const jobs: Array<Promise<void>> = [];
    const store = createInMemoryMeasurementBaselineStore();
    const worker = createInMemoryReviewWorker();
    const enqueue = vi.spyOn(worker, "enqueue");
    const publishCheckRun = vi.fn(async () => {
      throw new Error("a push must never publish a Check Run");
    });
    const comments = vi.fn(async () => {
      throw new Error("a push must never post a comment");
    });
    const engine = engineThatMustNotBeCalled();
    const built = createAppWebhookHandlers({
      supersession: createInMemorySupersessionStore(),
      worker,
      resolvePullRequest: async () => {
        throw new Error("a push resolves no pull request");
      },
      measurementBaselines: store,
      measure: probeReturning(),
      loadConfig: async () => DEPLOYED,
      // Awaited in the test instead of running behind the response, so the
      // assertions are about what happened rather than about timing.
      runBaselineJob: (task) => {
        jobs.push(task());
      },
      ...over,
    });
    return { built, store, jobs, enqueue, publishCheckRun, comments, engine };
  }

  it("records a baseline and touches no delivery surface", async () => {
    const h = handlers();
    await h.built.onPush(pushPayload());
    await Promise.all(h.jobs);

    expect(await findBaseline(h.store)).not.toBeNull();
    // The delivery side is not merely unused, it is unreachable: no Check Run
    // publisher, no comments API and no run store is passed to this path at all.
    expect(h.publishCheckRun).not.toHaveBeenCalled();
    expect(h.comments).not.toHaveBeenCalled();
    // And nothing was queued, so no review can be produced downstream either.
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("spends no model call, proven by an engine client that throws when touched", async () => {
    const h = handlers();
    // Touching either method is an immediate throw; the job below completes, so
    // neither was touched.
    expect(() => h.engine.review({} as never)).toThrow(/model call/);

    await h.built.onPush(pushPayload());
    await Promise.all(h.jobs);

    expect(await findBaseline(h.store)).not.toBeNull();
  });

  it("answers the webhook before the capture finishes", async () => {
    // GitHub gives a receiver ten seconds and retries what it thinks failed.
    // A handler that awaited a minutes-long capture would turn one push into a
    // retry storm.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = handlers({
      measure: {
        async measure() {
          await gate;
          return measured();
        },
      },
    });

    await h.built.onPush(pushPayload());
    expect(await findBaseline(h.store)).toBeNull(); // still capturing

    release();
    await Promise.all(h.jobs);
    expect(await findBaseline(h.store)).not.toBeNull();
  });

  it("accepts the push event on the webhook route without dispatching a review", async () => {
    const onPush = vi.fn(async () => undefined);
    const onPullRequest = vi.fn(async () => undefined);
    const onDeploymentStatus = vi.fn(async () => undefined);
    const server = buildServer({ webhook: { onPush, onPullRequest, onDeploymentStatus } });

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "push", "x-github-delivery": "d1" },
      payload: pushPayload() as object,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true, event: "push" });
    expect(onPush).toHaveBeenCalledTimes(1);
    expect(onPullRequest).not.toHaveBeenCalled();
    expect(onDeploymentStatus).not.toHaveBeenCalled();
    await server.close();
  });

  it("does not take the process down when the job itself rejects", async () => {
    const jobs: Array<Promise<void>> = [];
    const built = createAppWebhookHandlers({
      supersession: createInMemorySupersessionStore(),
      worker: createInMemoryReviewWorker(),
      resolvePullRequest: async () => null,
      measurementBaselines: createInMemoryMeasurementBaselineStore(),
      measure: {
        async measure() {
          throw new Error("engine is down");
        },
      },
      loadConfig: async () => DEPLOYED,
      runBaselineJob: (task) => {
        jobs.push(task());
      },
    });

    await built.onPush(pushPayload());
    await expect(Promise.all(jobs)).resolves.toBeDefined();
  });
});

describe("a push yields to a preview-measured set for the same commit", () => {
  /**
   * A tree-identical merge fires both mechanisms on one commit: the carry
   * copies the reviewed head's set onto the merge commit, and this path captures
   * the default branch's own deployment of it. Both are real measurements of the
   * same tree, so directness does not separate them. Where they were RENDERED
   * does: the carried set came from a pull request's preview, and the pull
   * request this baseline will be compared against is measured at a preview too.
   * Like against like wins, so this path stands down.
   */
  const carriedSet = (): MeasurementBaselineSnapshot =>
    buildMeasurementBaseline(measured(), {
      commitSha: COMMIT,
      measuredAt: { surface: "pull_request_preview", origin: "https://web-git-pr41.example.app" },
    });

  it("records nothing and spends no capture when the carry landed first", async () => {
    const probe = probeReturning();
    const d = deps({ measure: probe });
    await d.measurementBaselines.record({
      installationId: "7",
      owner: "acme",
      name: "web",
      commitSha: COMMIT,
      snapshot: carriedSet(),
    });

    const outcome = await recordDefaultBranchBaseline(pushPayload(), d);

    expect(outcome).toEqual({ status: "skipped", reason: "preview_baseline_exists" });
    // The browser is the expensive part, and yielding before it is the cheap
    // version of yielding.
    expect(probe.requests).toHaveLength(0);
    expect((await findBaseline(d.measurementBaselines))?.measuredAt?.surface).toBe("pull_request_preview");
  });

  it("discards its own measurement when the carry lands DURING the capture", async () => {
    // The race the second check exists for. Without it the winner is whichever
    // webhook finished last, which is exactly the unpredictability the
    // precedence rule is supposed to remove.
    const store = createInMemoryMeasurementBaselineStore();
    const d = deps({
      measurementBaselines: store,
      measure: {
        async measure() {
          await store.record({
            installationId: "7",
            owner: "acme",
            name: "web",
            commitSha: COMMIT,
            snapshot: carriedSet(),
          });
          return measured();
        },
      },
    });

    const outcome = await recordDefaultBranchBaseline(pushPayload(), d);

    expect(outcome).toEqual({ status: "skipped", reason: "preview_baseline_exists" });
    const stored = await findBaseline(store);
    expect(stored?.measuredAt?.surface).toBe("pull_request_preview");
    expect(stored?.measuredAt?.origin).toBe("https://web-git-pr41.example.app");
  });

  it("still records over a set measured at the default branch, and over one with no environment", async () => {
    // The control that keeps this from being a rule that stops pushes recording
    // anything. Only a PREVIEW-measured row outranks a fresh capture; a row this
    // same path wrote, or one written before environments were recorded, is
    // re-measured like any other commit.
    for (const previous of [
      buildMeasurementBaseline(measured(), {
        commitSha: COMMIT,
        measuredAt: { surface: "default_branch", origin: "https://app.example.com" },
      }),
      buildMeasurementBaseline(measured(), { commitSha: COMMIT }),
    ]) {
      const d = deps();
      await d.measurementBaselines.record({
        installationId: "7",
        owner: "acme",
        name: "web",
        commitSha: COMMIT,
        snapshot: previous,
      });

      const outcome = await recordDefaultBranchBaseline(pushPayload(), d);

      expect(outcome.status).toBe("recorded");
      expect((await findBaseline(d.measurementBaselines))?.recordedAtMs).toBe(4_000);
    }
  });

  it("records where it measured, so the next comparison can tell it apart from a preview", async () => {
    const d = deps({ loadConfig: async () => configWith({ defaultBranchUrl: "https://app.example.com/home" }) });
    await recordDefaultBranchBaseline(pushPayload(), d);

    // The SURFACE is what a comparison matches on; the origin is audit, and the
    // path is dropped from it because an origin is an address and not a page.
    expect((await findBaseline(d.measurementBaselines))?.measuredAt).toEqual({
      surface: "default_branch",
      origin: "https://app.example.com",
    });
  });
});
