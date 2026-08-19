import {
  buildMeasurementBaseline,
  type CheckRun,
  type CheckRunConclusion,
  decideDelivery,
  decideDeliveryForError,
  type GitHubCommentsApi,
  lookupMeasurementBaseline,
  type MeasurementBaselineStore,
  upsertStickyComment,
} from "@gate/delivery";
import {
  assertReviewOutcomeIdentity,
  classifyEngineFailure,
  EngineAbortedError,
  type EngineFailureKind,
  type JudgmentEngineClient,
  verifyPreviewHandoff,
} from "@gate/engine";
import { type PublishedReviewFacts, recordPublishedReview } from "@gate/observability";
import type { GateReviewRequest, NormalizedDesignReviewConfig } from "@gate/types";
import { carryBaselineOnMerge, type BaselineCarryForwardDeps } from "./baseline-carry-forward.js";
import {
  recordDefaultBranchBaseline,
  type DefaultBranchBaselineDeps,
} from "./default-branch-baseline.js";
import { decideReviewDepth, recordFullReviewIfDeep, traceDepthDecision } from "./depth-policy.js";
import { buildFeedbackEvent } from "./feedback-store.js";
import type { FeedbackSink } from "./feedback-routes.js";
import { resolveDeploymentPreview, type DeploymentStatusEvent } from "./deployment-preview.js";
import { type ReviewJobPayload, reviewQueueKey } from "./queue.js";
import type { ReviewJobWorker } from "./worker.js";
import type { FullReviewWindowStore } from "./review-window.js";
import type { RunStore } from "./run-store.js";
import {
  buildScreenshotRecords,
  type ScreenshotRegistryWriter,
  type ScreenshotVisibility,
} from "./screenshots.js";
import { currentShaKey, guardPublish, recordEnqueue, type SupersessionStore } from "./supersession.js";

/**
 * Hosted App-path orchestration (TRD §2, §5, §7; ARCHITECTURE §4): the App
 * counterpart to the Action-path runAction (#22). It composes the M2 pieces:
 * verify preview source (#39) -> choose depth (#43) -> submit the engine job with
 * the supersession signal threaded in (#4/#45) -> publish-time SHA guard (#4) ->
 * safe delivery (#38) -> sticky comment (#10) + Check Run (#11) -> feedback (#41).
 * Capture/critique run in the hosted engine sandbox (mocked here).
 */
export interface HostedReviewContext {
  installationId: string;
  repository: { owner: string; name: string; defaultBranch: string };
  pullRequest: { number: number; headSha: string; baseSha: string; title: string; body: string | null };
  isFork: boolean;
  preview: { url: string; provider: GateReviewRequest["preview"]["provider"]; source: string };
  /**
   * Component-library ids read from the repository's `package.json` at this
   * PR's head, forwarded so the engine's deep prompt carries the matching
   * rubric addendum. Optional and additive: a review that detected nothing
   * sends nothing and is grounded on tokens and brand exactly as before.
   */
  componentLibraries?: string[];
}

export interface HostedReviewDeps {
  supersession: SupersessionStore;
  windowStore: FullReviewWindowStore;
  engine: JudgmentEngineClient;
  comments: GitHubCommentsApi;
  publishCheckRun(run: CheckRun): Promise<void>;
  /**
   * Durable completed-run store (#69). When set, a completed published review is
   * persisted (and the deep full-review timestamp recorded) via one upsert,
   * making dashboard/billing queries and the 10-min cap durable; the windowStore
   * UPDATE no-ops without a run row, so this is the authoritative writer.
   */
  runStore?: RunStore;
  /** Durable screenshot-artifact registry (#71), written only for current completed reviews. */
  screenshotRegistry?: ScreenshotRegistryWriter;
  /**
   * Durable per-commit measurement sets, which is what makes "introduced by this
   * pull request" a statement Gate can support.
   *
   * Read for the pull request's BASE commit and written for its HEAD, so a
   * repository accumulates baselines as Gate reviews it and a run on the base
   * branch is what gives the next pull request something to be compared with.
   *
   * Optional, and its absence is not treated as a clean base: with no store,
   * every measurement is unclassified, `rules.measurements: block` fails nothing,
   * and both PR surfaces say so. The alternative, reading "I have never looked"
   * as "there was nothing there", fails a team's first pull request on their
   * whole back catalogue.
   */
  measurementBaselines?: MeasurementBaselineStore;
  /** Hosted App artifacts are private unless a caller explicitly marks them public. */
  screenshotVisibility?: ScreenshotVisibility;
  feedback?: FeedbackSink;
  /** Supersession signal from the worker (#48), threaded into the engine. */
  signal?: AbortSignal;
  runUrl?: string;
  now?: () => number;
  /**
   * Published-review counters, including `gate.review.green_over_measured`.
   *
   * Defaults to the real recorder for the same reason the Action path does: the
   * decision that deferred blocking said it would be revisited from this number,
   * and a number nobody records is a promise nobody can keep. Overridden in
   * tests only.
   */
  recordMetrics?: (facts: PublishedReviewFacts) => void;
}

export type HostedReviewStatus =
  | "published"
  | "superseded"
  | "stale_discarded"
  | "unverified_preview"
  /** The engine could not be reached, or failed in a way a retry can clear. */
  | "engine_error"
  /** The engine answered and refused the request; waiting does not fix it. */
  | "engine_rejected"
  /** The idempotency key for this (pr, head_sha) was spent on a different request. */
  | "idempotency_conflict";

/** One engine-failure kind, one run status, so the log says what the Check Run says. */
const ENGINE_FAILURE_STATUS: Record<EngineFailureKind, HostedReviewStatus> = {
  engine_unavailable: "engine_error",
  engine_rejected: "engine_rejected",
  idempotency_conflict: "idempotency_conflict",
};

export interface HostedReviewResult {
  status: HostedReviewStatus;
  conclusion?: CheckRunConclusion;
}

function neutralCheckRun(title: string, summary: string): CheckRun {
  return { name: "Apature Gate", conclusion: "neutral", title, summary };
}

export async function runHostedReview(
  config: NormalizedDesignReviewConfig,
  ctx: HostedReviewContext,
  deps: HostedReviewDeps,
): Promise<HostedReviewResult> {
  const repo = {
    installationId: ctx.installationId,
    owner: ctx.repository.owner,
    name: ctx.repository.name,
    prNumber: ctx.pullRequest.number,
  };
  const key = currentShaKey(repo);
  const now = deps.now ?? Date.now;

  const verified = verifyPreviewHandoff({
    url: ctx.preview.url,
    source: ctx.preview.source,
    provider: ctx.preview.provider,
    isFork: ctx.isFork,
    protectionBypassSecretName: config.preview.protectionBypassSecretName,
    authStateSecretName: config.preview.authStateSecretName,
  });
  if (!verified.ok) {
    if (!(await guardPublish(deps.supersession, key, ctx.pullRequest.headSha))) {
      return { status: "stale_discarded" };
    }
    await deps.publishCheckRun(neutralCheckRun("Preview not verified", verified.reason));
    return { status: "unverified_preview", conclusion: "neutral" };
  }

  const sanitizedConfig: NormalizedDesignReviewConfig = {
    ...config,
    preview: {
      ...config.preview,
      protectionBypassSecretName: verified.protectionBypassSecretName,
      authStateSecretName: verified.authStateSecretName,
    },
  };

  const depth = await decideReviewDepth(deps.windowStore, repo, now());
  traceDepthDecision(repo, depth);

  let outcome;
  try {
    outcome = await deps.engine.review(
      {
        installationId: ctx.installationId,
        repository: ctx.repository,
        pullRequest: ctx.pullRequest,
        preview: { url: verified.url, provider: verified.provider, environment: config.preview.environment },
        config: sanitizedConfig,
        publishMode: config.rules.gate === "blockers" ? "blocking" : "advisory",
        depth: depth.depth,
        ...(ctx.componentLibraries && ctx.componentLibraries.length > 0
          ? { componentLibraries: ctx.componentLibraries }
          : {}),
      },
      { signal: deps.signal },
    );
    assertReviewOutcomeIdentity(outcome, ctx);
  } catch (err) {
    if (err instanceof EngineAbortedError) {
      // Best-effort DELETE /jobs/:id so the engine stops the superseded job (§15.1).
      await deps.engine.cancel(err.jobId, ctx.installationId).catch(() => undefined);
      return { status: "superseded" }; // newer push won
    }
    // Engine unavailable / rejected / contract violation: neutral Check Run,
    // never crash the worker or block the PR (#38). The engine's own reason is
    // logged and published: a rejected request never clears on a retry, so it
    // must not be reported as an outage that will. Guard the Check Run too: an
    // older failed job must not publish any delivery after a newer push
    // supersedes it.
    const failure = classifyEngineFailure(err);
    console.error(`[gate] engine call failed (${failure.kind}): ${failure.message}`);
    if (!(await guardPublish(deps.supersession, key, ctx.pullRequest.headSha))) {
      return { status: "stale_discarded" };
    }
    const delivery = decideDeliveryForError(failure.kind, {
      code: failure.code,
      status: failure.status,
    });
    await deps.publishCheckRun({ name: "Apature Gate", ...delivery.checkRun });
    return { status: ENGINE_FAILURE_STATUS[failure.kind], conclusion: delivery.checkRun.conclusion };
  }

  // Publish-time guard: never overwrite a newer review with a stale result.
  if (!(await guardPublish(deps.supersession, key, ctx.pullRequest.headSha))) {
    return { status: "stale_discarded" };
  }

  if (outcome.status === "completed") {
    const at = now();
    if (deps.runStore) {
      // One upsert persists the completed run + records the deep full-review
      // timestamp (durable across restarts, #69); idempotent on the #65 identity.
      await deps.runStore.recordCompletedRun({
        installationId: ctx.installationId,
        owner: repo.owner,
        name: repo.name,
        prNumber: repo.prNumber,
        headSha: ctx.pullRequest.headSha,
        grade: outcome.result.grade,
        depth: depth.depth,
        engineVersion: outcome.result.metadata.engineVersion,
        model: outcome.result.metadata.model,
        uiDnaVersion: outcome.result.metadata.uiDnaVersion,
        lastFullReviewAtMs: depth.depth === "deep" ? at : undefined,
        expiresAtMs: at + outcome.result.screenshotRetentionSeconds * 1000,
      });
    } else {
      await recordFullReviewIfDeep(deps.windowStore, repo, depth.depth, at);
    }

    if (deps.screenshotRegistry) {
      await deps.screenshotRegistry.record(
        buildScreenshotRecords(outcome.result, at, {
          installationId: ctx.installationId,
          owner: repo.owner,
          name: repo.name,
          headSha: ctx.pullRequest.headSha,
          visibility: deps.screenshotVisibility ?? "private",
        }),
      );
    }

    // Record what this commit measured, so a later pull request based on it can
    // be told apart from it. Best-effort by design: a baseline that fails to
    // store costs the NEXT run its scoping, and must never cost THIS one its
    // review. The failure is logged rather than swallowed, because a store that
    // is quietly never written produces a fleet that silently never gates.
    if (deps.measurementBaselines) {
      try {
        await deps.measurementBaselines.record({
          installationId: ctx.installationId,
          owner: repo.owner,
          name: repo.name,
          commitSha: ctx.pullRequest.headSha,
          snapshot: buildMeasurementBaseline(outcome.result, {
            commitSha: ctx.pullRequest.headSha,
            recordedAtMs: at,
          }),
        });
      } catch (err) {
        console.error(
          `[gate] measurement baseline record failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // What this repository measured at the pull request's BASE. Always asked for
  // on this path, including when no store is bound: "Gate cannot classify these"
  // is a fact a reviewer needs, and leaving the question unasked would render
  // the measured half as if every pre-existing violation were this pull
  // request's doing.
  const measurementBaseline = await lookupMeasurementBaseline(deps.measurementBaselines, {
    installationId: ctx.installationId,
    owner: repo.owner,
    name: repo.name,
    commitSha: ctx.pullRequest.baseSha,
  });

  const decision = decideDelivery(outcome, {
    headSha: ctx.pullRequest.headSha,
    gate: config.rules.gate,
    minSeverityToComment: config.rules.minSeverityToComment,
    suppress: config.rules.suppress,
    measurements: config.rules.measurements,
    measurementSuppress: config.rules.measurementSuppress,
    measurementBaseline,
    runUrl: deps.runUrl,
  });
  if (decision.publishComment && decision.comment) {
    await upsertStickyComment(deps.comments, decision.comment);
  }
  await deps.publishCheckRun({ name: "Apature Gate", ...decision.checkRun });

  // After the publish, never before it: the metric is named for what reached the
  // pull request.
  (deps.recordMetrics ?? recordPublishedReview)({
    conclusion: decision.checkRun.conclusion,
    graded: decision.graded,
    greenOverMeasured: decision.greenOverMeasured,
    measurementKinds: decision.measurementKinds,
    suppressedMeasurementKinds: decision.suppressedMeasurementKinds,
    repository: `${repo.owner}/${repo.name}`,
    pullRequest: repo.prNumber,
    headSha: ctx.pullRequest.headSha,
  });

  if (deps.feedback && outcome.status === "completed") {
    await deps.feedback.record(
      buildFeedbackEvent(
        "finding_posted",
        {
          installationId: ctx.installationId,
          owner: repo.owner,
          name: repo.name,
          prNumber: repo.prNumber,
          headSha: ctx.pullRequest.headSha,
          source: "system",
          metadata: { findingCount: outcome.result.findings.length },
        },
        now(),
      ),
    );
  }

  return { status: "published", conclusion: decision.checkRun.conclusion };
}

export interface DeploymentHandlerDeps extends BaselineCarryForwardDeps, DefaultBranchBaselineDeps {
  supersession: SupersessionStore;
  worker: ReviewJobWorker;
  /**
   * Runs the default-branch baseline job OFF the webhook request.
   *
   * A capture takes minutes. GitHub gives a webhook receiver ten seconds and
   * RETRIES what it thinks failed, so awaiting the measure inside the delivery
   * would convert one push into a retry storm against the same engine the slow
   * capture is already occupying. The receiver therefore answers immediately and
   * the baseline finishes behind it. Nothing waits on the result and nothing is
   * published, so a process that restarts mid-run loses a baseline and nothing
   * else. Overridden in tests to await the job instead.
   */
  runBaselineJob?(task: () => Promise<void>): void;
  /** Resolve the PR for a deployment SHA in a given repo (GitHub lookup; injected). */
  resolvePullRequest(
    owner: string,
    name: string,
    sha: string,
    installationId: number,
  ): Promise<{ number: number; headSha: string; baseSha: string } | null>;
  environment?: string;
  isDuplicate?: (dedupeKey: string) => boolean | Promise<boolean>;
}

interface WebhookRepoEnvelope {
  installation?: { id?: number };
  repository?: { name?: string; owner?: { login?: string } };
}

/**
 * Build the `deployment_status` webhook handler (#1 dispatches to it): resolve
 * the preview (#55), record `current_sha` (supersession), and enqueue the review.
 * Repo + installation are read from the payload, so one handler serves every repo
 * the App is installed on.
 */
export function createDeploymentStatusHandler(deps: DeploymentHandlerDeps) {
  return async (payload: unknown): Promise<void> => {
    const resolved = await resolveDeploymentPreview(payload as DeploymentStatusEvent, {
      environment: deps.environment,
      isDuplicate: deps.isDuplicate,
    });
    if (!resolved.ok) return;

    // installationId + repo come from the webhook envelope; the engine HMAC (#47)
    // and tenant scoping depend on a real installationId, so skip if absent.
    const env = payload as WebhookRepoEnvelope;
    const installationId = env.installation?.id;
    const owner = env.repository?.owner?.login;
    const name = env.repository?.name;
    if (typeof installationId !== "number" || !owner || !name) return;

    const pr = await deps.resolvePullRequest(owner, name, resolved.sha, installationId);
    if (!pr || pr.headSha !== resolved.sha) return; // only the current head

    await recordEnqueue(deps.supersession, { owner, name, prNumber: pr.number }, pr.headSha);

    const payloadJob: ReviewJobPayload = {
      installationId: String(installationId),
      owner,
      name,
      prNumber: pr.number,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      previewUrl: resolved.url,
      previewProvider: resolved.provider,
      previewSource: resolved.source,
      depth: "deep",
      deploymentId: resolved.deploymentId,
    };
    await deps.worker.enqueue(payloadJob);
  };
}

/**
 * Compose the App-path webhook handlers for buildServer (#1): a `pull_request`
 * push bumps `current_sha` and cancels the in-flight older review (newest wins,
 * #4), a merged `pull_request` carries the reviewed head's measurement set onto
 * the merge commit when their trees are identical, `deployment_status`
 * resolves + enqueues the review (#55), and a `push` to the DEFAULT BRANCH
 * measures the new commit and stores its baseline without publishing anything.
 * All read the repo from the payload, so one set of handlers serves every
 * installation.
 */
export function createAppWebhookHandlers(deps: DeploymentHandlerDeps): {
  onPullRequest(payload: unknown): Promise<void>;
  onDeploymentStatus(payload: unknown): Promise<void>;
  onPush(payload: unknown): Promise<void>;
} {
  const onDeploymentStatus = createDeploymentStatusHandler(deps);
  return {
    async onPullRequest(payload) {
      const p = payload as WebhookRepoEnvelope & {
        pull_request?: { number?: number; head?: { sha?: string } };
      };
      const owner = p.repository?.owner?.login;
      const name = p.repository?.name;
      const prNumber = p.pull_request?.number;
      const headSha = p.pull_request?.head?.sha;
      if (!owner || !name || typeof prNumber !== "number" || !headSha) return;
      // Newest push wins: bump current_sha and cancel any in-flight older review.
      await recordEnqueue(deps.supersession, { owner, name, prNumber }, headSha);
      await deps.worker.cancel(reviewQueueKey(owner, name, prNumber));
      // A merge is what gives the NEXT pull request a base Gate has measured.
      // Best-effort in every direction: it decides for itself whether this
      // payload is a merge, it records nothing unless the merge commit's tree is
      // provably the tree that was measured, and it never throws.
      await carryBaselineOnMerge(payload, deps);
    },
    onDeploymentStatus,
    async onPush(payload) {
      // Deliberately NOT awaited: see `runBaselineJob`. `recordDefaultBranchBaseline`
      // resolves its own failures into an outcome and never rejects, so the
      // `catch` is the belt to that braces and exists so a future edit that made
      // it throw could not become an unhandled rejection that takes the process
      // down over a baseline nobody is waiting for.
      const run = (deps.runBaselineJob ?? ((task) => void task()));
      run(async () => {
        await recordDefaultBranchBaseline(payload, deps).catch((err: unknown) => {
          console.error(
            `[gate] default-branch baseline job escaped: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      });
    },
  };
}
