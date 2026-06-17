import {
  type CheckRun,
  type CheckRunConclusion,
  decideDelivery,
  type GitHubCommentsApi,
  upsertStickyComment,
} from "@gate/delivery";
import { EngineAbortedError, type JudgmentEngineClient, verifyPreviewHandoff } from "@gate/engine";
import type { GateReviewRequest, NormalizedDesignReviewConfig } from "@gate/types";
import { decideReviewDepth, recordFullReviewIfDeep, traceDepthDecision } from "./depth-policy.js";
import { buildFeedbackEvent } from "./feedback-store.js";
import type { FeedbackSink } from "./feedback-routes.js";
import { resolveDeploymentPreview, type DeploymentStatusEvent } from "./deployment-preview.js";
import { type ReviewJobPayload } from "./queue.js";
import type { ReviewJobWorker } from "./worker.js";
import type { FullReviewWindowStore } from "./review-window.js";
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
  | "unverified_preview";

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
  const repo = { owner: ctx.repository.owner, name: ctx.repository.name, prNumber: ctx.pullRequest.number };
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
    await deps.publishCheckRun(neutralCheckRun("Preview not verified", verified.reason));
    return { status: "unverified_preview", conclusion: "neutral" };
  }

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
        config,
        publishMode: config.rules.gate === "blockers" ? "blocking" : "advisory",
        depth: depth.depth,
      },
      { signal: deps.signal },
    );
  } catch (err) {
    if (err instanceof EngineAbortedError) return { status: "superseded" }; // newer push won
    throw err;
  }

  // Publish-time guard: never overwrite a newer review with a stale result.
  if (!(await guardPublish(deps.supersession, key, ctx.pullRequest.headSha))) {
    return { status: "stale_discarded" };
  }

  if (outcome.status === "completed") {
    await recordFullReviewIfDeep(deps.windowStore, repo, depth.depth, now());
  }

  const decision = decideDelivery(outcome, {
    headSha: ctx.pullRequest.headSha,
    gate: config.rules.gate,
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
  /** Resolve the PR for a deployment SHA (GitHub lookup; injected for testability). */
  resolvePullRequest(sha: string): Promise<{ number: number; headSha: string; baseSha: string } | null>;
  environment?: string;
  isDuplicate?: (dedupeKey: string) => boolean | Promise<boolean>;
}

/**
 * Build the `deployment_status` webhook handler (#1 dispatches to it): resolve
 * the preview (#55), record `current_sha` (supersession), and enqueue the review.
 */
export function createDeploymentStatusHandler(repository: { owner: string; name: string }, deps: DeploymentHandlerDeps) {
  return async (payload: unknown): Promise<void> => {
    const resolved = await resolveDeploymentPreview(payload as DeploymentStatusEvent, {
      environment: deps.environment,
      isDuplicate: deps.isDuplicate,
    });
    if (!resolved.ok) return;

    const pr = await deps.resolvePullRequest(resolved.sha);
    if (!pr || pr.headSha !== resolved.sha) return; // only the current head

    await recordEnqueue(deps.supersession, { owner: repository.owner, name: repository.name, prNumber: pr.number }, pr.headSha);

    const payloadJob: ReviewJobPayload = {
      installationId: "", // filled by the App context at enqueue time
      owner: repository.owner,
      name: repository.name,
      prNumber: pr.number,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      previewUrl: resolved.url,
      previewProvider: "vercel",
      previewSource: resolved.source,
      depth: "deep",
      deploymentId: resolved.deploymentId,
    };
    await deps.worker.enqueue(payloadJob);
  };
}
