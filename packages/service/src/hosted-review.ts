import {
  type CheckRun,
  type CheckRunConclusion,
  decideDelivery,
  decideDeliveryForError,
  type GitHubCommentsApi,
  upsertStickyComment,
} from "@gate/delivery";
import { EngineAbortedError, type JudgmentEngineClient, verifyPreviewHandoff } from "@gate/engine";
import type { GateReviewRequest, NormalizedDesignReviewConfig } from "@gate/types";
import { decideReviewDepth, recordFullReviewIfDeep, traceDepthDecision } from "./depth-policy.js";
import { buildFeedbackEvent } from "./feedback-store.js";
import type { FeedbackSink } from "./feedback-routes.js";
import { resolveDeploymentPreview, type DeploymentStatusEvent } from "./deployment-preview.js";
import { type ReviewJobPayload, reviewQueueKey } from "./queue.js";
import type { ReviewJobWorker } from "./worker.js";
import type { FullReviewWindowStore } from "./review-window.js";
import type { RunStore } from "./run-store.js";
import { currentShaKey, guardPublish, recordEnqueue, type SupersessionStore } from "./supersession.js";

/**
 * Hosted App-path orchestration (TRD §2, §5, §7; ARCHITECTURE §4) — the App
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
  feedback?: FeedbackSink;
  /** Supersession signal from the worker (#48), threaded into the engine. */
  signal?: AbortSignal;
  runUrl?: string;
  now?: () => number;
}

export type HostedReviewStatus =
  | "published"
  | "superseded"
  | "stale_discarded"
  | "unverified_preview"
  | "engine_error";

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
      },
      { signal: deps.signal },
    );
  } catch (err) {
    if (err instanceof EngineAbortedError) {
      // Best-effort DELETE /jobs/:id so the engine stops the superseded job (§15.1).
      await deps.engine.cancel(err.jobId).catch(() => undefined);
      return { status: "superseded" }; // newer push won
    }
    // Engine unavailable / contract violation: neutral Check Run, never crash the
    // worker or block the PR (#38). Guard the Check Run too: an older failed job
    // must not publish any delivery after a newer push supersedes it.
    if (!(await guardPublish(deps.supersession, key, ctx.pullRequest.headSha))) {
      return { status: "stale_discarded" };
    }
    const failure = decideDeliveryForError("engine_unavailable");
    await deps.publishCheckRun({ name: "Apature Gate", ...failure.checkRun });
    return { status: "engine_error", conclusion: failure.checkRun.conclusion };
  }

  // Publish-time guard: never overwrite a newer review with a stale result.
  if (!(await guardPublish(deps.supersession, key, ctx.pullRequest.headSha))) {
    return { status: "stale_discarded" };
  }

  if (outcome.status === "completed") {
    if (deps.runStore) {
      // One upsert persists the completed run + records the deep full-review
      // timestamp (durable across restarts, #69); idempotent on the #65 identity.
      const at = now();
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
      await recordFullReviewIfDeep(deps.windowStore, repo, depth.depth, now());
    }
  }

  const decision = decideDelivery(outcome, {
    headSha: ctx.pullRequest.headSha,
    gate: config.rules.gate,
    minSeverityToComment: config.rules.minSeverityToComment,
    suppress: config.rules.suppress,
    runUrl: deps.runUrl,
  });
  if (decision.publishComment && decision.comment) {
    await upsertStickyComment(deps.comments, decision.comment);
  }
  await deps.publishCheckRun({ name: "Apature Gate", ...decision.checkRun });

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

export interface DeploymentHandlerDeps {
  supersession: SupersessionStore;
  worker: ReviewJobWorker;
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
 * Repo + installation are read from the payload — one handler serves every repo
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
 * #4), and `deployment_status` resolves + enqueues the review (#55). Both read
 * the repo from the payload, so one set of handlers serves every installation.
 */
export function createAppWebhookHandlers(deps: DeploymentHandlerDeps): {
  onPullRequest(payload: unknown): Promise<void>;
  onDeploymentStatus(payload: unknown): Promise<void>;
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
    },
    onDeploymentStatus,
  };
}
