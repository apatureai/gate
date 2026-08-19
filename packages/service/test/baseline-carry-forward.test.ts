import { DEFAULT_CONFIG } from "@gate/config";
import {
  buildMeasurementBaseline,
  carryMeasurementBaselineForward,
  createInMemoryMeasurementBaselineStore,
  MEASUREMENT_IDENTITY_VERSION,
  type CheckRun,
  type GitHubCommentsApi,
  type MeasurementBaselineSnapshot,
  type MeasurementBaselineStore,
} from "@gate/delivery";
import { canonicalReviewIdentity, type JudgmentEngineClient, type PollOutcome } from "@gate/engine";
import {
  loadMeasuredReviewResult,
  type GateReviewResult,
  type Measurement,
  type NormalizedDesignReviewConfig,
} from "@gate/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  carryBaselineOnMerge,
  type MergeCommitTreeReader,
} from "../src/baseline-carry-forward.js";
import { createAppWebhookHandlers, runHostedReview, type HostedReviewContext } from "../src/hosted-review.js";
import { createInMemoryFullReviewWindow } from "../src/review-window.js";
import { createInMemorySupersessionStore, recordEnqueue } from "../src/supersession.js";

/**
 * The merge carry-forward: the thing that makes `rules.measurements: block`
 * capable of firing on a repository that merges its pull requests.
 *
 * Gate scopes measured violations against the set stored for a pull request's
 * BASE commit, and only ever recorded sets for a pull request's HEAD. Every
 * merge strategy GitHub offers puts a commit on the base branch that was never
 * any pull request's head, so the next pull request's base was a commit Gate had
 * never measured and `block` failed nothing.
 *
 * The whole design is one condition: copy the stored set onto the merge commit
 * ONLY when the merge commit's tree sha equals the tree sha of the head that was
 * measured. Equal trees are identical content, so the copy states a fact.
 * Unequal trees mean the merge produced something nobody rendered, and a copy
 * there would assert a measurement result that no capture and no engine ever
 * produced. Most of what follows tests that Gate declines.
 */

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const MERGE_SHA = "aaaabbbbccccddddeeeeffff0000111122223333";
const TREE_SHA = "77777777777777777777777777777777777aaaaa";
const OTHER_TREE = "88888888888888888888888888888888888bbbbb";

const measured = loadMeasuredReviewResult();

function mergedPayload(over: Record<string, unknown> = {}): unknown {
  return {
    action: "closed",
    installation: { id: 1 },
    repository: { name: "web", owner: { login: "acme" } },
    pull_request: {
      number: 42,
      merged: true,
      merge_commit_sha: MERGE_SHA,
      head: { sha: HEAD_SHA },
      base: { ref: "main", sha: "olderbase" },
    },
    ...over,
  };
}

/** A tree reader with a fixed sha per commit; anything unknown reads as unreadable. */
function trees(map: Record<string, string | null>): MergeCommitTreeReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getCommitTreeSha(_owner, _name, sha) {
      calls.push(sha);
      return map[sha] ?? null;
    },
  };
}

async function storeWithHeadSet(): Promise<ReturnType<typeof createInMemoryMeasurementBaselineStore>> {
  const store = createInMemoryMeasurementBaselineStore();
  await store.record({
    installationId: "1",
    owner: "acme",
    name: "web",
    commitSha: HEAD_SHA,
    snapshot: buildMeasurementBaseline(measured, { commitSha: HEAD_SHA, recordedAtMs: 1_000 }),
  });
  return store;
}

const findMerge = (store: MeasurementBaselineStore): Promise<MeasurementBaselineSnapshot | null> =>
  store.find({ installationId: "1", owner: "acme", name: "web", commitSha: MERGE_SHA });

describe("carryBaselineOnMerge: identical trees are the only thing that justifies a copy", () => {
  it("copies the reviewed head's set onto the merge commit when the trees match", async () => {
    const store = await storeWithHeadSet();
    const commits = trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA });

    const outcome = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits,
      now: () => 5_000,
    });

    expect(outcome).toEqual({ status: "carried", from: HEAD_SHA, to: MERGE_SHA, treeSha: TREE_SHA });
    // Both commits are compared. A copy made without reading both trees is a
    // copy made without the fact that justifies it.
    expect(commits.calls.sort()).toEqual([HEAD_SHA, MERGE_SHA].sort());

    const carried = await findMerge(store);
    expect(carried).not.toBeNull();
    expect(carried?.commitSha).toBe(MERGE_SHA);
    expect(carried?.entries).toHaveLength(measured.measurements?.violations.length ?? 0);
  });

  it("marks the copy as carried and keeps the engine and identity versions it was computed under", async () => {
    const store = await storeWithHeadSet();
    const observed = await store.find({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: HEAD_SHA,
    });

    await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
      now: () => 5_000,
    });
    const carried = await findMerge(store);

    // Carried, not freshly observed, and it names the commit that was rendered.
    expect(carried?.carriedFrom).toBe(HEAD_SHA);
    expect(observed?.carriedFrom).toBeUndefined();
    // Nothing re-derived: the identity version and engine version are the ones
    // the measurements were computed under, so a later comparison refuses this
    // set for version skew on exactly the terms it would refuse the original.
    expect(carried?.version).toBe(observed?.version);
    expect(carried?.version).toBe(MEASUREMENT_IDENTITY_VERSION);
    expect(carried?.engineVersion).toBe(observed?.engineVersion);
    expect(carried?.checksRun).toEqual(observed?.checksRun);
    expect(carried?.routesMeasured).toEqual(observed?.routesMeasured);
    expect(carried?.viewportsMeasured).toEqual(observed?.viewportsMeasured);
    expect(carried?.entries).toEqual(observed?.entries);
    // The copy's own timestamp, so an audit can see when it was made.
    expect(carried?.recordedAtMs).toBe(5_000);
  });

  it("records NOTHING when the merge commit's tree differs from the tree that was measured", async () => {
    // A squash onto a base that moved, or a merge commit combining two branches:
    // the resulting content was never rendered, never captured and never
    // measured. Copying here would gate the next pull request against a result
    // nothing produced.
    const store = await storeWithHeadSet();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const outcome = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: OTHER_TREE }),
    });

    expect(outcome).toEqual({ status: "tree_changed", headSha: HEAD_SHA, mergeSha: MERGE_SHA });
    expect(await findMerge(store)).toBeNull();
    // And it says why, because a fleet that silently carries nothing forward
    // looks exactly like one that has nothing to carry.
    const said = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("declined");
    expect(said).toContain(MERGE_SHA);
    expect(said).toContain(OTHER_TREE);
    expect(said).toContain(TREE_SHA);
    log.mockRestore();
  });

  it("records nothing when a commit cannot be read: a missing answer is not a match", async () => {
    const store = await storeWithHeadSet();
    const outcome = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA }), // merge commit unreadable
    });

    expect(outcome).toEqual({ status: "unreadable_commit", headSha: HEAD_SHA, mergeSha: MERGE_SHA });
    expect(await findMerge(store)).toBeNull();
  });

  it("records nothing when BOTH trees are unreadable, rather than treating null === null as a match", async () => {
    // The failure mode this guards: two unreadable commits both answer `null`,
    // and an equality check on the raw answers would call that a match and copy
    // a measurement set across two commits nobody compared.
    const store = await storeWithHeadSet();
    const outcome = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({}),
    });

    expect(outcome.status).toBe("unreadable_commit");
    expect(await findMerge(store)).toBeNull();
  });
});

describe("carryBaselineOnMerge: what is not a merge", () => {
  it("does nothing when the pull request was closed WITHOUT merging", async () => {
    // Nothing was put on the base branch, so there is no commit to carry a set
    // onto. GitHub still sends a merge_commit_sha here, left over from a
    // mergeability probe, naming a commit that is on no branch.
    const store = await storeWithHeadSet();
    const commits = trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA });
    const record = vi.spyOn(store, "record");

    const outcome = await carryBaselineOnMerge(
      mergedPayload({
        pull_request: {
          number: 42,
          merged: false,
          merge_commit_sha: MERGE_SHA,
          head: { sha: HEAD_SHA },
        },
      }),
      { measurementBaselines: store, commits },
    );

    expect(outcome).toEqual({ status: "not_merged" });
    expect(record).not.toHaveBeenCalled();
    expect(commits.calls).toEqual([]);
    expect(await findMerge(store)).toBeNull();
  });

  it("does nothing on a push to an open pull request", async () => {
    const store = await storeWithHeadSet();
    const commits = trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA });

    const outcome = await carryBaselineOnMerge(mergedPayload({ action: "synchronize" }), {
      measurementBaselines: store,
      commits,
    });

    expect(outcome).toEqual({ status: "not_merged" });
    expect(commits.calls).toEqual([]);
    expect(await findMerge(store)).toBeNull();
  });

  it("does nothing on a non-pull_request payload", async () => {
    const store = await storeWithHeadSet();
    for (const payload of [null, undefined, "closed", {}, { action: "closed" }]) {
      expect(await carryBaselineOnMerge(payload, { measurementBaselines: store, commits: trees({}) })).toEqual({
        status: "not_merged",
      });
    }
    expect(await findMerge(store)).toBeNull();
  });

  it("skips an incomplete merged payload rather than guessing the missing half", async () => {
    const store = await storeWithHeadSet();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await carryBaselineOnMerge(
      mergedPayload({
        pull_request: { number: 42, merged: true, head: { sha: HEAD_SHA } }, // no merge_commit_sha
      }),
      { measurementBaselines: store, commits: trees({}) },
    );
    expect(outcome).toEqual({ status: "skipped", reason: "incomplete_event" });
    expect(await findMerge(store)).toBeNull();
    err.mockRestore();
  });

  it("does not rewrite an observed row as a carried one when the merge commit IS the head", async () => {
    const store = await storeWithHeadSet();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const outcome = await carryBaselineOnMerge(
      mergedPayload({
        pull_request: { number: 42, merged: true, merge_commit_sha: HEAD_SHA, head: { sha: HEAD_SHA } },
      }),
      { measurementBaselines: store, commits: trees({ [HEAD_SHA]: TREE_SHA }) },
    );

    expect(outcome).toEqual({ status: "skipped", reason: "merge_is_head" });
    const head = await store.find({ installationId: "1", owner: "acme", name: "web", commitSha: HEAD_SHA });
    expect(head?.carriedFrom).toBeUndefined(); // still an observed set
    log.mockRestore();
  });

  it("carries nothing when no store or no commit reader is bound", async () => {
    const store = await storeWithHeadSet();
    expect(await carryBaselineOnMerge(mergedPayload(), { commits: trees({}) })).toEqual({
      status: "skipped",
      reason: "not_configured",
    });
    expect(await carryBaselineOnMerge(mergedPayload(), { measurementBaselines: store })).toEqual({
      status: "skipped",
      reason: "not_configured",
    });
    expect(await findMerge(store)).toBeNull();
  });
});

describe("carryBaselineOnMerge: never lets a failure reach the pull request", () => {
  it("records nothing when the head was never measured", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    const commits = trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const outcome = await carryBaselineOnMerge(mergedPayload(), { measurementBaselines: store, commits });

    expect(outcome).toEqual({ status: "no_baseline", headSha: HEAD_SHA });
    expect(await findMerge(store)).toBeNull();
    // No point paying for two GitHub reads when there is nothing to copy.
    expect(commits.calls).toEqual([]);
    log.mockRestore();
  });

  it("logs and returns when the store's read throws, and never raises", async () => {
    const broken: MeasurementBaselineStore = {
      async record() {
        throw new Error("write failed");
      },
      async find() {
        throw new Error("connection refused");
      },
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: broken,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
    });

    expect(outcome).toEqual({ status: "failed", detail: "connection refused" });
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain("connection refused");
    err.mockRestore();
  });

  it("logs and returns when the store's WRITE throws, and never raises", async () => {
    const store = await storeWithHeadSet();
    vi.spyOn(store, "record").mockRejectedValue(new Error("disk full"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const outcome = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
    });

    expect(outcome).toEqual({ status: "failed", detail: "disk full" });
    err.mockRestore();
    log.mockRestore();
    vi.restoreAllMocks();
  });

  it("logs and returns when the commit read throws, and never raises", async () => {
    const store = await storeWithHeadSet();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: {
        async getCommitTreeSha() {
          throw new Error("502 from GitHub");
        },
      },
    });

    expect(outcome).toEqual({ status: "failed", detail: "502 from GitHub" });
    expect(await findMerge(store)).toBeNull();
    err.mockRestore();
  });
});

describe("carryMeasurementBaselineForward", () => {
  it("carries a set recorded under an OLDER identity version without re-stamping it", async () => {
    // The dangerous re-derivation. Re-stamping the copy with the CURRENT
    // identity version would turn a set that the comparison is supposed to
    // refuse for skew into one it accepts, and it would then be compared entry
    // by entry against a normalization Gate no longer uses. Nothing is
    // re-derived precisely so this cannot happen.
    const stale: MeasurementBaselineSnapshot = {
      ...buildMeasurementBaseline(measured, { commitSha: HEAD_SHA }),
      version: "measurement-identity-from-two-releases-ago",
      engineVersion: "engine-0.1.0",
    };
    const carried = carryMeasurementBaselineForward(stale, { commitSha: MERGE_SHA });

    expect(carried.version).toBe("measurement-identity-from-two-releases-ago");
    expect(carried.version).not.toBe(MEASUREMENT_IDENTITY_VERSION);
    expect(carried.engineVersion).toBe("engine-0.1.0");
  });

  it("a carried set under an old identity version is refused for skew, not gated on", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    await store.record({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: HEAD_SHA,
      snapshot: {
        ...buildMeasurementBaseline(
          { ...measured, measurements: { checksRun: ["contrast"], violations: [] } },
          { commitSha: HEAD_SHA },
        ),
        version: "measurement-identity-from-two-releases-ago",
      },
    });
    await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
    });

    const carried = await findMerge(store);
    expect(carried?.version).toBe("measurement-identity-from-two-releases-ago");

    const blockMode: NormalizedDesignReviewConfig = {
      ...DEFAULT_CONFIG,
      rules: { ...DEFAULT_CONFIG.rules, measurements: "block" },
    };
    const published: CheckRun[] = [];
    const supersession = createInMemorySupersessionStore();
    const nextHead = "beef0000beef0000beef0000beef0000beef0000";
    await recordEnqueue(supersession, { owner: "acme", name: "web", prNumber: 43 }, nextHead);
    await runHostedReview(
      blockMode,
      {
        installationId: "1",
        repository: { owner: "acme", name: "web", defaultBranch: "main" },
        pullRequest: { number: 43, headSha: nextHead, baseSha: MERGE_SHA, title: "t", body: null },
        isFork: false,
        preview: { url: "https://acme.vercel.app", provider: "vercel", source: "deployment_status" },
      },
      {
        supersession,
        windowStore: createInMemoryFullReviewWindow(),
        engine: {
          review: vi.fn(async (reviewCtx) => ({
            status: "completed" as const,
            result: measured,
            jobId: "j",
            reviewIdentity: canonicalReviewIdentity(reviewCtx),
          })),
          cancel: vi.fn(async () => {}),
        },
        comments: {
          listComments: vi.fn(async () => []),
          createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
          updateComment: vi.fn(async () => ({ updated: true })),
        },
        publishCheckRun: async (r: CheckRun) => void published.push(r),
        recordMetrics: () => {},
        measurementBaselines: store,
      },
    );

    // Carrying a stale set forward must not launder it into a comparable one.
    expect(published[0]?.conclusion).not.toBe("failure");
    expect(published[0]?.summary).toContain("no usable baseline");
    expect(published[0]?.summary).toContain("measurement-identity-from-two-releases-");
    expect(published[0]?.summary).toContain("cannot be compared");
  });

  it("names the commit that was MEASURED when a carried set is carried again", async () => {
    // Two merges in a row (a merge queue, a release branch merged onward) must
    // keep pointing at the commit whose pages were actually rendered, not at the
    // intermediate commit the set passed through.
    const observed = buildMeasurementBaseline(measured, { commitSha: HEAD_SHA });
    const once = carryMeasurementBaselineForward(observed, { commitSha: MERGE_SHA });
    const twice = carryMeasurementBaselineForward(once, { commitSha: "secondmerge" });

    expect(once.carriedFrom).toBe(HEAD_SHA);
    expect(twice.carriedFrom).toBe(HEAD_SHA);
    expect(twice.commitSha).toBe("secondmerge");
    expect(twice.entries).toEqual(observed.entries);
  });
});

describe("the merged pull_request webhook carries the baseline forward", () => {
  it("wires the carry-forward into the App's pull_request handler", async () => {
    const store = await storeWithHeadSet();
    const worker = { enqueue: vi.fn(async () => "k"), cancel: vi.fn(async () => {}), onJob: () => {} };
    const handlers = createAppWebhookHandlers({
      supersession: createInMemorySupersessionStore(),
      worker,
      resolvePullRequest: async () => null,
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
    });

    await handlers.onPullRequest(mergedPayload());

    expect((await findMerge(store))?.carriedFrom).toBe(HEAD_SHA);
  });

  it("still supersedes and cancels, and never throws, when the carry-forward fails", async () => {
    const worker = { enqueue: vi.fn(async () => "k"), cancel: vi.fn(async () => {}), onJob: () => {} };
    const supersession = createInMemorySupersessionStore();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const handlers = createAppWebhookHandlers({
      supersession,
      worker,
      resolvePullRequest: async () => null,
      measurementBaselines: {
        async record() {
          throw new Error("nope");
        },
        async find() {
          throw new Error("nope");
        },
      },
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
    });

    await expect(handlers.onPullRequest(mergedPayload())).resolves.toBeUndefined();
    expect(await supersession.getCurrentSha("sha:acme/web#42")).toBe(HEAD_SHA);
    expect(worker.cancel).toHaveBeenCalledWith("acme/web#42");
    err.mockRestore();
  });
});

/**
 * The end of the story, which is the only thing that proves the gap is closed:
 * a pull request merges, the set is carried onto the merge commit, and the NEXT
 * pull request, whose base is that merge commit, actually gates.
 */
describe("a merged pull request gives the next one a base to be gated against", () => {
  const blockMode: NormalizedDesignReviewConfig = {
    ...DEFAULT_CONFIG,
    rules: { ...DEFAULT_CONFIG.rules, measurements: "block" },
  };
  const NEXT_HEAD = "cafe0000cafe0000cafe0000cafe0000cafe0000";

  const cleanBase: GateReviewResult = {
    ...measured,
    measurements: { checksRun: measured.measurements?.checksRun ?? [], violations: [] },
  };

  function engineReturning(outcome: PollOutcome): JudgmentEngineClient {
    return {
      review: vi.fn(async (reviewCtx) => ({ ...outcome, reviewIdentity: canonicalReviewIdentity(reviewCtx) })),
      cancel: vi.fn(async () => {}),
    };
  }

  async function reviewOf(result: GateReviewResult, ctx: HostedReviewContext, store: MeasurementBaselineStore) {
    const comments: GitHubCommentsApi = {
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
      updateComment: vi.fn(async () => ({ updated: true })),
    };
    const published: CheckRun[] = [];
    const supersession = createInMemorySupersessionStore();
    await recordEnqueue(
      supersession,
      { owner: "acme", name: "web", prNumber: ctx.pullRequest.number },
      ctx.pullRequest.headSha,
    );
    await runHostedReview(blockMode, ctx, {
      supersession,
      windowStore: createInMemoryFullReviewWindow(),
      engine: engineReturning({ status: "completed", result, jobId: "j" }),
      comments,
      publishCheckRun: async (r: CheckRun) => void published.push(r),
      recordMetrics: () => {},
      measurementBaselines: store,
    });
    return published[0];
  }

  const contextFor = (prNumber: number, headSha: string, baseSha: string): HostedReviewContext => ({
    installationId: "1",
    repository: { owner: "acme", name: "web", defaultBranch: "main" },
    pullRequest: { number: prNumber, headSha, baseSha, title: "t", body: null },
    isFork: false,
    preview: { url: "https://acme.vercel.app", provider: "vercel", source: "deployment_status" },
  });

  let store: MeasurementBaselineStore;
  beforeEach(() => {
    store = createInMemoryMeasurementBaselineStore();
  });

  it("fails the next pull request on a violation it introduced, once the merge carried the base forward", async () => {
    // 1. Pull request #1 is reviewed and its head is clean.
    await reviewOf(cleanBase, contextFor(42, HEAD_SHA, "olderbase"), store);
    // 2. It merges. The merge commit's tree is the tree that was measured.
    const carried = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
    });
    expect(carried.status).toBe("carried");
    // 3. Pull request #2 branches off the merge commit and adds violations.
    const check = await reviewOf(measured, contextFor(43, NEXT_HEAD, MERGE_SHA), store);

    expect(check?.conclusion).toBe("failure");
    expect(check?.title).toBe("Measured violations");
    expect(check?.summary).toContain("introduced by this pull request");
  });

  it("still says 'no baseline' for the next pull request when the merge changed the tree", async () => {
    await reviewOf(cleanBase, contextFor(42, HEAD_SHA, "olderbase"), store);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const declined = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: OTHER_TREE }),
    });
    log.mockRestore();
    expect(declined.status).toBe("tree_changed");

    const check = await reviewOf(measured, contextFor(43, NEXT_HEAD, MERGE_SHA), store);

    // It bites in the safe direction and says which of the two happened.
    expect(check?.conclusion).not.toBe("failure");
    expect(check?.summary).toContain("no baseline");
  });

  it("does not let a carried base absolve a violation the next pull request added", async () => {
    // Pull request #1 shipped violations, they were carried onto the merge
    // commit, and pull request #2 adds one MORE of the same defect on the same
    // page. A carried set must spend its entries exactly like an observed one.
    const extra: Measurement = {
      kind: "contrast",
      route: "/pricing",
      viewports: ["mobile"],
      element: "#hero-cta",
      detail: "text contrast 2.10:1 is below WCAG AA 4.5:1",
      blockEligible: true,
    };
    const withExtra: GateReviewResult = {
      ...measured,
      measurements: {
        checksRun: measured.measurements?.checksRun ?? [],
        violations: [...(measured.measurements?.violations ?? []), extra],
      },
    };

    await reviewOf(measured, contextFor(42, HEAD_SHA, "olderbase"), store);
    await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
    });

    const check = await reviewOf(withExtra, contextFor(43, NEXT_HEAD, MERGE_SHA), store);

    expect(check?.conclusion).toBe("failure");
    expect(check?.summary).toContain("1 introduced by this pull request");
  });
});

describe("a merge that fires both mechanisms has one predictable winner", () => {
  /**
   * A merge whose tree matched fires the carry-forward AND the default-branch
   * push on the same commit. The store upserts on (repository, commit), so the
   * winner would otherwise be whichever webhook arrived second, and the two do
   * not measure the same thing: the copy comes from the pull request's preview
   * deployment, the push from the default branch's own URL.
   *
   * THE RULE REVERSED ON AUGUST 19, 2026. It used to be that a directly observed
   * set outranks a copy. Both are observed, though: tree equality is what allowed
   * the copy, and equal trees are identical content, so the carried set is a real
   * capture of exactly this commit's content. What separates them is where they
   * were RENDERED, and a baseline exists to be compared against the next pull
   * request, which is measured at that pull request's own preview. So the
   * preview-measured set wins, whichever webhook lands first.
   */
  const previewSet = (commitSha: string): MeasurementBaselineSnapshot =>
    buildMeasurementBaseline(measured, {
      commitSha,
      recordedAtMs: 1_000,
      measuredAt: { surface: "pull_request_preview", origin: "https://web-git-pr42.example.app" },
    });

  const pushedSet = (): MeasurementBaselineSnapshot =>
    buildMeasurementBaseline(measured, {
      commitSha: MERGE_SHA,
      recordedAtMs: 2_000,
      measuredAt: { surface: "default_branch", origin: "https://app.example.com" },
    });

  async function storeWithPreviewHeadSet(): Promise<ReturnType<typeof createInMemoryMeasurementBaselineStore>> {
    const store = createInMemoryMeasurementBaselineStore();
    await store.record({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: HEAD_SHA,
      snapshot: previewSet(HEAD_SHA),
    });
    return store;
  }

  it("replaces a set the push measured at the default branch", async () => {
    const store = await storeWithPreviewHeadSet();
    // The push landed first and captured production.
    await store.record({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: MERGE_SHA,
      snapshot: pushedSet(),
    });

    const outcome = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
      now: () => 5_000,
    });

    expect(outcome.status).toBe("carried");
    const stored = await findMerge(store);
    expect(stored?.carriedFrom).toBe(HEAD_SHA);
    expect(stored?.measuredAt?.surface).toBe("pull_request_preview");
  });

  it("ends at the same stored row whichever webhook finished first", async () => {
    // Order-independence is what the old rule was really protecting, and it is
    // kept: the carry overwrites a pushed set, and the push path declines to
    // overwrite a carried one.
    const pushFirst = await storeWithPreviewHeadSet();
    await pushFirst.record({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: MERGE_SHA,
      snapshot: pushedSet(),
    });
    await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: pushFirst,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
      now: () => 5_000,
    });

    const carryFirst = await storeWithPreviewHeadSet();
    await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: carryFirst,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
      now: () => 5_000,
    });

    expect(await findMerge(pushFirst)).toEqual(await findMerge(carryFirst));
  });

  it("declines when the stored set is already preview-measured", async () => {
    // Nothing to improve on, so nothing is rewritten. Two carries of the same
    // head must not churn the row, and a set an earlier merge already carried is
    // the same evidence this one holds.
    const store = await storeWithPreviewHeadSet();
    await store.record({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: MERGE_SHA,
      snapshot: previewSet(MERGE_SHA),
    });

    const outcome = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
    });

    expect(outcome).toEqual({ status: "already_recorded", mergeSha: MERGE_SHA });
    expect((await findMerge(store))?.recordedAtMs).toBe(1_000);
  });

  it("declines when neither set can say where it was rendered", async () => {
    // Both sides unknown: nothing shows the copy is the better baseline, so the
    // stored row stands. Unknown never displaces, in either direction.
    const store = await storeWithHeadSet();
    await store.record({
      installationId: "1",
      owner: "acme",
      name: "web",
      commitSha: MERGE_SHA,
      snapshot: buildMeasurementBaseline(measured, { commitSha: MERGE_SHA, recordedAtMs: 2_000 }),
    });

    const outcome = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
    });

    expect(outcome.status).toBe("already_recorded");
    expect((await findMerge(store))?.carriedFrom).toBeUndefined();
  });

  it("still carries when nothing has been observed for that commit", async () => {
    // The control: the rule is about which set wins, not about declining to
    // work. Most merges carry, because nothing else has written that commit.
    const store = await storeWithHeadSet();

    const outcome = await carryBaselineOnMerge(mergedPayload(), {
      measurementBaselines: store,
      commits: trees({ [HEAD_SHA]: TREE_SHA, [MERGE_SHA]: TREE_SHA }),
    });

    expect(outcome.status).toBe("carried");
    expect((await findMerge(store))?.carriedFrom).toBe(HEAD_SHA);
  });
});
