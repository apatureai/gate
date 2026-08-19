import { DEFAULT_CONFIG } from "@gate/config";
import {
  createInMemoryMeasurementBaselineStore,
  type MeasurementBaselineSnapshot,
  type MeasurementBaselineStore,
} from "@gate/delivery";
import type { JudgmentEngineClient } from "@gate/engine";
import type {
  GateMeasurementRequest,
  GateMeasurementResult,
  NormalizedDesignReviewConfig,
} from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app.js";
import { measureDefaultBranchBaseline } from "../src/default-branch-baseline.js";
import { createGitHubRepositoryClient } from "../src/github-repository.js";
import { createAppWebhookHandlers } from "../src/hosted-review.js";
import {
  INSTALLATION_BASELINE_CONCURRENCY,
  parseInstallationScope,
  recordInstallationBaselines,
  type InstallationBaselineDeps,
} from "../src/installation-baseline.js";
import { createInMemorySupersessionStore } from "../src/supersession.js";
import { createInMemoryReviewWorker } from "../src/worker.js";

/**
 * A repository should be protected from its FIRST pull request.
 *
 * Before this, a default branch acquired baselines from the first push after the
 * App arrived. A team that installed Gate, set `rules.measurements: block` and
 * opened a pull request the same afternoon got a check that classified nothing
 * and failed nothing, and it looked exactly like a check that passed. The only
 * event that can close that is the installation itself.
 *
 * So most of what follows is about the two ways this could be worse than the
 * problem. An installation must not produce anything a person could read as a
 * review, because an installation is not a review. And it must not stampede: one
 * delivery can name every repository an organisation has, and each one costs a
 * browser capture in the same service that is answering pull requests somebody
 * is waiting on.
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";

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
      routesRequested: ["/"],
      routesReviewed: ["/"],
      viewportsRequested: ["mobile"],
      viewportsReviewed: ["mobile"],
    },
    metadata: { engineVersion: "verdict@9.9.9", captureVersion: "capture@2" },
    ...over,
  };
}

/**
 * A probe that answers with a fixed measurement and records BOTH what it was
 * asked and how many captures were ever in flight at once. The peak is the whole
 * point of the concurrency bound: a number nobody measures is exactly the kind of
 * all-clear this repository keeps producing by accident.
 */
function trackingProbe(result: GateMeasurementResult = measured()) {
  const requests: GateMeasurementRequest[] = [];
  let inFlight = 0;
  let peak = 0;
  return {
    requests,
    get peakConcurrency(): number {
      return peak;
    },
    async measure(request: GateMeasurementRequest): Promise<GateMeasurementResult> {
      requests.push(request);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return result;
    },
  };
}

/**
 * The model client, wired so that touching it is a test failure. "An install
 * never spends a model call" is only testable by making the forbidden call throw.
 */
function engineThatMustNotBeCalled(): JudgmentEngineClient {
  return {
    review() {
      throw new Error("an installation must never call the judgment engine: that is a model call");
    },
    cancel() {
      throw new Error("an installation must never call the judgment engine: that is a model call");
    },
  };
}

function configWith(
  over: Partial<NormalizedDesignReviewConfig["preview"]>,
): NormalizedDesignReviewConfig {
  return { ...DEFAULT_CONFIG, preview: { ...DEFAULT_CONFIG.preview, ...over } };
}

const DEPLOYED = configWith({ defaultBranchUrl: "https://app.example.com" });

/** `installation` / `action: created`, the delivery that arrives on install. */
function installationPayload(over: Record<string, unknown> = {}): unknown {
  return {
    action: "created",
    installation: { id: 7, account: { login: "acme" } },
    repositories: [{ id: 1, name: "web", full_name: "acme/web", private: true }],
    ...over,
  };
}

/** `installation_repositories` / `action: added`, the later add. */
function addedPayload(over: Record<string, unknown> = {}): unknown {
  return {
    action: "added",
    installation: { id: 7, account: { login: "acme" } },
    repositories_added: [{ id: 2, name: "docs", full_name: "acme/docs", private: false }],
    repositories_removed: [],
    ...over,
  };
}

function deps(
  over: Partial<InstallationBaselineDeps> = {},
): InstallationBaselineDeps & { measurementBaselines: MeasurementBaselineStore } {
  return {
    measurementBaselines: createInMemoryMeasurementBaselineStore(),
    measure: trackingProbe(),
    loadConfig: async () => DEPLOYED,
    readDefaultBranchHead: async () => ({ defaultBranch: "main", commitSha: COMMIT }),
    now: () => 4_000,
    ...over,
  } as InstallationBaselineDeps & { measurementBaselines: MeasurementBaselineStore };
}

const findBaseline = (
  store: MeasurementBaselineStore,
  name = "web",
  commitSha = COMMIT,
): Promise<MeasurementBaselineSnapshot | null> =>
  store.find({ installationId: "7", owner: "acme", name, commitSha });

describe("recordInstallationBaselines: installing scopes the repository", () => {
  it("records one baseline for one installed repository", async () => {
    const d = deps();
    const outcome = await recordInstallationBaselines("installation", installationPayload(), d);

    expect(outcome).toEqual({
      status: "scoped",
      installationId: "7",
      repositories: 1,
      recorded: 1,
      results: [
        {
          repository: "acme/web",
          outcome: { status: "recorded", commitSha: COMMIT, checksRun: 2, entries: 1 },
        },
      ],
    });

    const stored = await findBaseline(d.measurementBaselines);
    expect(stored).not.toBeNull();
    expect(stored?.commitSha).toBe(COMMIT);
    expect(stored?.entries).toHaveLength(1);
    // Observed, not carried: this commit was actually rendered and measured.
    expect(stored?.carriedFrom).toBeUndefined();
  });

  it("records one for a repository added to an existing installation", async () => {
    const d = deps({
      readDefaultBranchHead: async () => ({ defaultBranch: "main", commitSha: OTHER_COMMIT }),
    });
    const outcome = await recordInstallationBaselines(
      "installation_repositories",
      addedPayload(),
      d,
    );

    expect(outcome.status).toBe("scoped");
    // The added list is a DIFFERENT field from `installation`'s. A handler that
    // read `repositories` here would find nothing and scope nothing, silently.
    expect(await findBaseline(d.measurementBaselines, "docs", OTHER_COMMIT)).not.toBeNull();
  });

  it("measures the branch the repository actually has, never an assumed `main`", async () => {
    const probe = trackingProbe();
    const d = deps({
      measure: probe,
      readDefaultBranchHead: async () => ({ defaultBranch: "trunk", commitSha: COMMIT }),
    });
    await recordInstallationBaselines("installation", installationPayload(), d);

    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]!.repository).toEqual({
      owner: "acme",
      name: "web",
      defaultBranch: "trunk",
    });
    expect(probe.requests[0]!.commitSha).toBe(COMMIT);
    expect(probe.requests[0]!.installationId).toBe("7");
  });

  it("reads the repository's own config at the commit it measures", async () => {
    const seen: Array<{ owner: string; name: string; commitSha: string }> = [];
    const probe = trackingProbe();
    const d = deps({
      measure: probe,
      loadConfig: async (target) => {
        seen.push({ owner: target.owner, name: target.name, commitSha: target.commitSha });
        return configWith({ defaultBranchUrl: "https://app.example.com/{short_sha}" });
      },
    });
    await recordInstallationBaselines("installation", installationPayload(), d);

    expect(seen).toEqual([{ owner: "acme", name: "web", commitSha: COMMIT }]);
    expect(probe.requests[0]!.preview.url).toBe("https://app.example.com/0123456");
  });

  it("takes the owner from full_name, so the capture goes at the right deployment", async () => {
    const probe = trackingProbe();
    const d = deps({ measure: probe });
    await recordInstallationBaselines(
      "installation",
      installationPayload({
        installation: { id: 7, account: { login: "acme" } },
        repositories: [{ name: "web", full_name: "other-org/web" }],
      }),
      d,
    );

    expect(probe.requests[0]!.repository.owner).toBe("other-org");
  });

  it("falls back to the installation account when an entry carries only a name", async () => {
    const probe = trackingProbe();
    const d = deps({ measure: probe });
    await recordInstallationBaselines(
      "installation",
      installationPayload({ repositories: [{ name: "web" }] }),
      d,
    );

    expect(probe.requests[0]!.repository).toEqual({
      owner: "acme",
      name: "web",
      defaultBranch: "main",
    });
  });

  it("skips an entry that names neither an owner nor an account rather than guessing one", async () => {
    const probe = trackingProbe();
    const d = deps({ measure: probe });
    const outcome = await recordInstallationBaselines(
      "installation",
      {
        action: "created",
        installation: { id: 7 },
        repositories: [{ name: "web" }],
      },
      d,
    );

    // A wrong owner would point a browser at somebody else's deployment and file
    // the result under this tenant.
    expect(outcome).toEqual({ status: "skipped", reason: "incomplete_event" });
    expect(probe.requests).toHaveLength(0);
  });
});

describe("recordInstallationBaselines: everything that must record nothing", () => {
  it("records nothing for a repository with no preview.default_branch_url", async () => {
    const probe = trackingProbe();
    const d = deps({ measure: probe, loadConfig: async () => DEFAULT_CONFIG });
    const outcome = await recordInstallationBaselines("installation", installationPayload(), d);

    expect(outcome).toEqual({
      status: "scoped",
      installationId: "7",
      repositories: 1,
      recorded: 0,
      results: [
        {
          repository: "acme/web",
          outcome: { status: "skipped", reason: "no_default_branch_url" },
        },
      ],
    });
    // Gate will not guess an address to point a browser at, so no capture was
    // even requested.
    expect(probe.requests).toHaveLength(0);
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("records nothing when repositories are REMOVED from an installation", async () => {
    const probe = trackingProbe();
    const d = deps({ measure: probe });
    const outcome = await recordInstallationBaselines(
      "installation_repositories",
      {
        action: "removed",
        installation: { id: 7, account: { login: "acme" } },
        repositories_added: [],
        repositories_removed: [{ id: 1, name: "web", full_name: "acme/web" }],
      },
      d,
    );

    // The distinguishing payload for the action guard: the removal delivery
    // carries a full repository list. A handler that fell back across the two
    // fields would capture a deployment Gate was just told to stop looking at.
    expect(outcome).toEqual({ status: "ignored", event: "installation_repositories", action: "removed" });
    expect(probe.requests).toHaveLength(0);
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("records nothing when the App is UNINSTALLED, which carries the same list as an install", async () => {
    const probe = trackingProbe();
    const d = deps({ measure: probe });
    const outcome = await recordInstallationBaselines(
      "installation",
      installationPayload({ action: "deleted" }),
      d,
    );

    expect(outcome).toEqual({ status: "ignored", event: "installation", action: "deleted" });
    expect(probe.requests).toHaveLength(0);
    expect(await findBaseline(d.measurementBaselines)).toBeNull();
  });

  it("records nothing on suspend, unsuspend or a permissions bump", async () => {
    const probe = trackingProbe();
    const d = deps({ measure: probe });
    for (const action of ["suspend", "unsuspend", "new_permissions_accepted"]) {
      const outcome = await recordInstallationBaselines(
        "installation",
        installationPayload({ action }),
        d,
      );
      expect(outcome).toEqual({ status: "ignored", event: "installation", action });
    }
    expect(probe.requests).toHaveLength(0);
  });

  it("records nothing for a repository whose default branch cannot be read", async () => {
    const probe = trackingProbe();
    const d = deps({ measure: probe, readDefaultBranchHead: async () => null });
    const outcome = await recordInstallationBaselines("installation", installationPayload(), d);

    expect(outcome).toEqual({
      status: "scoped",
      installationId: "7",
      repositories: 1,
      recorded: 0,
      results: [{ repository: "acme/web", outcome: { status: "unreadable_repository" } }],
    });
    // An empty repository has a default branch NAME and no commit on it. There
    // is nothing to measure, and measuring anyway would need a guessed commit.
    expect(probe.requests).toHaveLength(0);
  });

  it("records nothing when the payload has no installation id", async () => {
    const probe = trackingProbe();
    const d = deps({ measure: probe });
    const outcome = await recordInstallationBaselines(
      "installation",
      installationPayload({ installation: { account: { login: "acme" } } }),
      d,
    );

    expect(outcome).toEqual({ status: "skipped", reason: "incomplete_event" });
    expect(probe.requests).toHaveLength(0);
  });

  it("records nothing when the delivery names no repositories", async () => {
    const probe = trackingProbe();
    const d = deps({ measure: probe });
    const outcome = await recordInstallationBaselines(
      "installation",
      installationPayload({ repositories: [] }),
      d,
    );

    expect(outcome).toEqual({ status: "skipped", reason: "no_repositories" });
    expect(probe.requests).toHaveLength(0);
  });

  it("records nothing when no repository reader is bound, and never guesses the branch", async () => {
    const probe = trackingProbe();
    const outcome = await recordInstallationBaselines("installation", installationPayload(), {
      measurementBaselines: createInMemoryMeasurementBaselineStore(),
      measure: probe,
      loadConfig: async () => DEPLOYED,
    });

    expect(outcome).toEqual({ status: "skipped", reason: "not_configured" });
    expect(probe.requests).toHaveLength(0);
  });

  it("records nothing when no measure probe is bound, and never falls back to a review", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    const outcome = await recordInstallationBaselines("installation", installationPayload(), {
      measurementBaselines: store,
      loadConfig: async () => DEPLOYED,
      readDefaultBranchHead: async () => ({ defaultBranch: "main", commitSha: COMMIT }),
    });

    expect(outcome).toEqual({ status: "skipped", reason: "not_configured" });
    expect(await findBaseline(store)).toBeNull();
  });

  it("records nothing when no baseline store is bound", async () => {
    const probe = trackingProbe();
    const outcome = await recordInstallationBaselines("installation", installationPayload(), {
      measure: probe,
      loadConfig: async () => DEPLOYED,
      readDefaultBranchHead: async () => ({ defaultBranch: "main", commitSha: COMMIT }),
    });

    expect(outcome).toEqual({ status: "skipped", reason: "not_configured" });
    expect(probe.requests).toHaveLength(0);
  });
});

describe("recordInstallationBaselines: a long repository list does not stampede", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ name: `r${i}`, full_name: `acme/r${i}` }));

  it("measures at most INSTALLATION_BASELINE_CONCURRENCY repositories at once", async () => {
    const probe = trackingProbe();
    const d = deps({ measure: probe });
    const outcome = await recordInstallationBaselines(
      "installation",
      installationPayload({ repositories: many(12) }),
      d,
    );

    expect(outcome.status).toBe("scoped");
    expect(probe.requests).toHaveLength(12);
    expect(probe.peakConcurrency).toBe(INSTALLATION_BASELINE_CONCURRENCY);
    // The bound is what the default is FOR. Unbounded, twelve captures would be
    // in flight at once against a pool serving pull requests somebody is waiting
    // on, and an organisation-wide install is not twelve, it is hundreds.
    expect(INSTALLATION_BASELINE_CONCURRENCY).toBeLessThan(12);
  });

  it("drops nothing: every repository in a long list still gets its baseline", async () => {
    const d = deps({ installationConcurrency: 3 });
    const outcome = await recordInstallationBaselines(
      "installation",
      installationPayload({ repositories: many(11) }),
      d,
    );

    expect(outcome).toMatchObject({ status: "scoped", repositories: 11, recorded: 11 });
    for (let i = 0; i < 11; i += 1) {
      expect(await findBaseline(d.measurementBaselines, `r${i}`)).not.toBeNull();
    }
  });

  it("honours a configured width", async () => {
    const probe = trackingProbe();
    await recordInstallationBaselines(
      "installation",
      installationPayload({ repositories: many(9) }),
      deps({ measure: probe, installationConcurrency: 4 }),
    );

    expect(probe.peakConcurrency).toBe(4);
  });

  it("never runs zero workers, which would hang the whole installation", async () => {
    const probe = trackingProbe();
    const outcome = await recordInstallationBaselines(
      "installation",
      installationPayload({ repositories: many(3) }),
      deps({ measure: probe, installationConcurrency: 0 }),
    );

    expect(outcome).toMatchObject({ status: "scoped", recorded: 3 });
    expect(probe.peakConcurrency).toBe(1);
  });

  it("does not spin up more workers than there are repositories", async () => {
    const probe = trackingProbe();
    await recordInstallationBaselines(
      "installation",
      installationPayload({ repositories: many(2) }),
      deps({ measure: probe, installationConcurrency: 50 }),
    );

    expect(probe.peakConcurrency).toBe(2);
  });
});

describe("recordInstallationBaselines: one repository's failure costs only that repository", () => {
  it("keeps going when a measure throws for one repository", async () => {
    const d = deps({
      measure: {
        async measure(request: GateMeasurementRequest) {
          if (request.repository.name === "b") throw new Error("engine is down");
          return measured();
        },
      },
      installationConcurrency: 1,
    });
    const outcome = await recordInstallationBaselines(
      "installation",
      installationPayload({
        repositories: [
          { name: "a", full_name: "acme/a" },
          { name: "b", full_name: "acme/b" },
          { name: "c", full_name: "acme/c" },
        ],
      }),
      d,
    );

    expect(outcome).toMatchObject({ status: "scoped", repositories: 3, recorded: 2 });
    expect(await findBaseline(d.measurementBaselines, "a")).not.toBeNull();
    expect(await findBaseline(d.measurementBaselines, "b")).toBeNull();
    expect(await findBaseline(d.measurementBaselines, "c")).not.toBeNull();
  });

  it("keeps going when the repository read itself throws", async () => {
    const d = deps({
      readDefaultBranchHead: async (repo) => {
        if (repo.name === "b") throw new Error("403 from GitHub");
        return { defaultBranch: "main", commitSha: COMMIT };
      },
      installationConcurrency: 2,
    });
    const outcome = await recordInstallationBaselines(
      "installation",
      installationPayload({
        repositories: [
          { name: "a", full_name: "acme/a" },
          { name: "b", full_name: "acme/b" },
          { name: "c", full_name: "acme/c" },
        ],
      }),
      d,
    );

    expect(outcome).toMatchObject({ status: "scoped", repositories: 3, recorded: 2 });
    const results = outcome.status === "scoped" ? outcome.results : [];
    expect(results[1]).toEqual({
      repository: "acme/b",
      outcome: { status: "unreadable_repository", detail: "403 from GitHub" },
    });
    expect(await findBaseline(d.measurementBaselines, "c")).not.toBeNull();
  });

  it("keeps going when the baseline store throws for one repository", async () => {
    const inner = createInMemoryMeasurementBaselineStore();
    const store: MeasurementBaselineStore = {
      async record(record) {
        if (record.name === "a") throw new Error("baselines table is unavailable");
        await inner.record(record);
      },
      find: inner.find.bind(inner),
    };
    const outcome = await recordInstallationBaselines(
      "installation",
      installationPayload({
        repositories: [
          { name: "a", full_name: "acme/a" },
          { name: "b", full_name: "acme/b" },
        ],
      }),
      deps({ measurementBaselines: store }),
    );

    expect(outcome).toMatchObject({ status: "scoped", repositories: 2, recorded: 1 });
    expect(await findBaseline(inner, "b")).not.toBeNull();
  });

  it("never retries a repository whose measure failed", async () => {
    const measure = vi.fn(async () => {
      throw new Error("engine is down");
    });
    await recordInstallationBaselines(
      "installation",
      installationPayload(),
      deps({ measure: { measure } }),
    );

    // Nobody is waiting on this answer, and a retry across a large installation
    // is a stampede against an engine that is already failing.
    expect(measure).toHaveBeenCalledTimes(1);
  });
});

describe("parseInstallationScope", () => {
  it("reports a non-object payload as incomplete", () => {
    expect(parseInstallationScope("installation", null).kind).toBe("incomplete");
    expect(parseInstallationScope("installation", "created").kind).toBe("incomplete");
  });

  it("reads `repositories` for an install and `repositories_added` for an add", () => {
    const created = parseInstallationScope("installation", installationPayload());
    expect(created).toEqual({
      kind: "scope",
      installationId: "7",
      repositories: [{ owner: "acme", name: "web" }],
    });

    const added = parseInstallationScope("installation_repositories", addedPayload());
    expect(added).toEqual({
      kind: "scope",
      installationId: "7",
      repositories: [{ owner: "acme", name: "docs" }],
    });
  });

  it("does not read an install's list on an add, or the reverse", () => {
    // Each event names its list in its own field. Falling back across them is how
    // a removal delivery ends up scoping repositories.
    expect(
      parseInstallationScope("installation_repositories", {
        action: "added",
        installation: { id: 7 },
        repositories: [{ full_name: "acme/web" }],
      }).kind,
    ).toBe("no_repositories");
    expect(
      parseInstallationScope("installation", {
        action: "created",
        installation: { id: 7 },
        repositories_added: [{ full_name: "acme/web" }],
      }).kind,
    ).toBe("no_repositories");
  });

  it("refuses a full_name that is not owner/name", () => {
    for (const full_name of ["acme", "/web", "acme/"]) {
      expect(
        parseInstallationScope("installation", {
          action: "created",
          installation: { id: 7 },
          repositories: [{ full_name }],
        }).kind,
      ).toBe("incomplete");
    }
  });

  it("keeps a repository whose name contains a slash", () => {
    expect(
      parseInstallationScope("installation", {
        action: "created",
        installation: { id: 7 },
        repositories: [{ full_name: "acme/web/extra" }],
      }),
    ).toEqual({ kind: "scope", installationId: "7", repositories: [{ owner: "acme", name: "web/extra" }] });
  });
});

describe("the installation handler publishes nothing and calls no model", () => {
  /** The App webhook handlers, with every publishing surface wired to explode. */
  function handlers(over: Partial<InstallationBaselineDeps> = {}) {
    const jobs: Array<Promise<void>> = [];
    const store = createInMemoryMeasurementBaselineStore();
    const worker = createInMemoryReviewWorker();
    const enqueue = vi.spyOn(worker, "enqueue");
    const publishCheckRun = vi.fn(async () => {
      throw new Error("an installation must never publish a Check Run");
    });
    const comments = vi.fn(async () => {
      throw new Error("an installation must never post a comment");
    });
    const engine = engineThatMustNotBeCalled();
    const built = createAppWebhookHandlers({
      supersession: createInMemorySupersessionStore(),
      worker,
      resolvePullRequest: async () => {
        throw new Error("an installation resolves no pull request");
      },
      measurementBaselines: store,
      measure: trackingProbe(),
      loadConfig: async () => DEPLOYED,
      readDefaultBranchHead: async () => ({ defaultBranch: "main", commitSha: COMMIT }),
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
    await h.built.onInstallation(installationPayload());
    await Promise.all(h.jobs);

    expect(await findBaseline(h.store)).not.toBeNull();
    // The delivery side is not merely unused, it is unreachable: no Check Run
    // publisher, no comments API and no run store reaches this path at all.
    expect(h.publishCheckRun).not.toHaveBeenCalled();
    expect(h.comments).not.toHaveBeenCalled();
    // And nothing was queued, so no review can be produced downstream either.
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("spends no model call, proven by an engine client that throws when touched", async () => {
    const h = handlers();
    expect(() => h.engine.review({} as never)).toThrow(/model call/);

    await h.built.onInstallation(installationPayload());
    await h.built.onInstallationRepositories(addedPayload());
    await Promise.all(h.jobs);

    expect(await findBaseline(h.store)).not.toBeNull();
  });

  it("answers the webhook before the captures finish", async () => {
    // GitHub gives a receiver ten seconds and retries what it thinks failed. An
    // organisation-wide install is hours of captures.
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

    await h.built.onInstallation(installationPayload());
    expect(await findBaseline(h.store)).toBeNull(); // still capturing

    release();
    await Promise.all(h.jobs);
    expect(await findBaseline(h.store)).not.toBeNull();
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
      readDefaultBranchHead: async () => {
        throw new Error("GitHub is down");
      },
      runBaselineJob: (task) => {
        jobs.push(task());
      },
    });

    await built.onInstallation(installationPayload());
    await expect(Promise.all(jobs)).resolves.toBeDefined();
  });

  it("accepts both installation events on the webhook route without dispatching a review", async () => {
    const onInstallation = vi.fn(async () => undefined);
    const onInstallationRepositories = vi.fn(async () => undefined);
    const onPullRequest = vi.fn(async () => undefined);
    const onDeploymentStatus = vi.fn(async () => undefined);
    const onPush = vi.fn(async () => undefined);
    const server = buildServer({
      webhook: {
        onInstallation,
        onInstallationRepositories,
        onPullRequest,
        onDeploymentStatus,
        onPush,
      },
    });

    const created = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "installation", "x-github-delivery": "d1" },
      payload: installationPayload() as object,
    });
    expect(created.statusCode).toBe(202);
    expect(created.json()).toEqual({ accepted: true, event: "installation" });

    const added = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "installation_repositories", "x-github-delivery": "d2" },
      payload: addedPayload() as object,
    });
    expect(added.statusCode).toBe(202);
    expect(added.json()).toEqual({ accepted: true, event: "installation_repositories" });

    expect(onInstallation).toHaveBeenCalledTimes(1);
    expect(onInstallationRepositories).toHaveBeenCalledTimes(1);
    expect(onPullRequest).not.toHaveBeenCalled();
    expect(onDeploymentStatus).not.toHaveBeenCalled();
    expect(onPush).not.toHaveBeenCalled();
    await server.close();
  });
});

describe("measureDefaultBranchBaseline: the seam the push path and this path share", () => {
  it("records nothing when it is called with no store and no probe", async () => {
    // The installation path and the push path both screen for this before they
    // get here, so this guard is the one that holds for any THIRD caller: it is
    // exported, and a caller that reached it with nothing bound would otherwise
    // fall through to a measure on an undefined probe.
    const outcome = await measureDefaultBranchBaseline(
      {
        installationId: "7",
        owner: "acme",
        name: "web",
        defaultBranch: "main",
        commitSha: COMMIT,
      },
      { loadConfig: async () => DEPLOYED },
    );

    expect(outcome).toEqual({ status: "skipped", reason: "not_configured" });
  });

  it("is the same function the installation path calls, not a copy of it", async () => {
    // Reuse is the claim: everything true of a push (measurements only, no model
    // call, nothing published) is true here by construction rather than by a
    // second implementation somebody has to keep honest.
    const d = deps();
    const direct = await measureDefaultBranchBaseline(
      {
        installationId: "7",
        owner: "acme",
        name: "web",
        defaultBranch: "main",
        commitSha: COMMIT,
      },
      d,
    );
    expect(direct).toEqual({ status: "recorded", commitSha: COMMIT, checksRun: 2, entries: 1 });

    const viaInstallation = await recordInstallationBaselines(
      "installation",
      installationPayload(),
      deps(),
    );
    expect(viaInstallation).toMatchObject({
      status: "scoped",
      results: [{ repository: "acme/web", outcome: direct }],
    });
  });
});

describe("createGitHubRepositoryClient", () => {
  function fetcher(routes: Record<string, { status: number; body?: unknown }>) {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(String(url));
      const route = routes[String(url)] ?? { status: 404 };
      return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
        status: route.status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const REPO_URL = "https://api.github.com/repos/acme/web";

  it("reads the default branch and its tip commit", async () => {
    const { impl, calls } = fetcher({
      [REPO_URL]: { status: 200, body: { default_branch: "trunk" } },
      [`${REPO_URL}/git/ref/heads/trunk`]: { status: 200, body: { object: { sha: COMMIT } } },
    });
    const client = createGitHubRepositoryClient("t", impl);

    expect(await client.readDefaultBranchHead("acme", "web")).toEqual({
      defaultBranch: "trunk",
      commitSha: COMMIT,
    });
    // The git-database ref endpoint, not `/commits/{branch}`, which also serves
    // the commit's full file diff.
    expect(calls[1]).toBe(`${REPO_URL}/git/ref/heads/trunk`);
  });

  it("keeps a default branch name with a slash in it as two path segments", async () => {
    const { impl } = fetcher({
      [REPO_URL]: { status: 200, body: { default_branch: "release/v2" } },
      [`${REPO_URL}/git/ref/heads/release/v2`]: { status: 200, body: { object: { sha: COMMIT } } },
    });

    expect(await createGitHubRepositoryClient("t", impl).readDefaultBranchHead("acme", "web")).toEqual({
      defaultBranch: "release/v2",
      commitSha: COMMIT,
    });
  });

  it("answers null when the repository cannot be read", async () => {
    const { impl } = fetcher({ [REPO_URL]: { status: 404 } });
    expect(await createGitHubRepositoryClient("t", impl).readDefaultBranchHead("acme", "web")).toBeNull();
  });

  it("answers null when the repository names no default branch", async () => {
    const { impl } = fetcher({ [REPO_URL]: { status: 200, body: {} } });
    expect(await createGitHubRepositoryClient("t", impl).readDefaultBranchHead("acme", "web")).toBeNull();
  });

  it("answers null for an empty repository, whose default branch has no commit", async () => {
    const { impl } = fetcher({
      [REPO_URL]: { status: 200, body: { default_branch: "main" } },
      [`${REPO_URL}/git/ref/heads/main`]: { status: 404 },
    });
    expect(await createGitHubRepositoryClient("t", impl).readDefaultBranchHead("acme", "web")).toBeNull();
  });

  it("answers null when the ref carries no sha", async () => {
    const { impl } = fetcher({
      [REPO_URL]: { status: 200, body: { default_branch: "main" } },
      [`${REPO_URL}/git/ref/heads/main`]: { status: 200, body: { object: {} } },
    });
    expect(await createGitHubRepositoryClient("t", impl).readDefaultBranchHead("acme", "web")).toBeNull();
  });

  it("answers null for an EMPTY sha, not just a missing one", async () => {
    // The distinguishing payload for that guard: a present-but-empty string is a
    // string, so a typeof check alone would pass it through and the installation
    // would file a measurement set under the commit `""`.
    const { impl } = fetcher({
      [REPO_URL]: { status: 200, body: { default_branch: "main" } },
      [`${REPO_URL}/git/ref/heads/main`]: { status: 200, body: { object: { sha: "" } } },
    });
    expect(await createGitHubRepositoryClient("t", impl).readDefaultBranchHead("acme", "web")).toBeNull();
  });

  it("never asks for a ref it has no branch name for", async () => {
    const { impl, calls } = fetcher({ [REPO_URL]: { status: 200, body: { default_branch: "" } } });
    await createGitHubRepositoryClient("t", impl).readDefaultBranchHead("acme", "web");
    expect(calls).toEqual([REPO_URL]);
  });
});
