import {
  type CheckRun,
  type CheckRunConclusion,
  decideDelivery,
  decideDeliveryForError,
  type GitHubCommentsApi,
  upsertStickyComment,
} from "@gate/delivery";
import { type JudgmentEngineClient, verifyPreviewHandoff } from "@gate/engine";
import type { NormalizedDesignReviewConfig } from "@gate/types";
import { type ProviderComment, resolvePreviewUrl } from "./preview.js";

/**
 * Action-path orchestration (TRD §2, §4, §7): resolve a preview URL, verify its
 * source, submit a hosted engine job via the async /jobs API, then post the
 * sticky comment and an advisory Check Run. Capture/annotation happen
 * engine-side; the runner only hands over a verified URL. Judgment-only — never
 * requests contents: write.
 */
export interface ActionRunContext {
  installationId: string;
  repository: { owner: string; name: string; defaultBranch: string };
  pullRequest: { number: number; headSha: string; baseSha: string; title: string; body: string | null };
  isFork: boolean;
  /** Existing PR comments, used for provider-bot preview discovery. */
  previewComments: ProviderComment[];
}

export interface ActionRunInputs {
  previewUrl: string | null;
  previewCommand: string | null;
  /** URL the local server is reachable at after `preview-command` runs. */
  localServeUrl?: string | null;
}

export interface ActionRunDeps {
  engine: JudgmentEngineClient;
  comments: GitHubCommentsApi;
  /** Publish-time SHA guard; re-reads the current PR head from GitHub. */
  getCurrentHeadSha(): Promise<string>;
  publishCheckRun(run: CheckRun): Promise<void>;
  /** Gate-built public run URL (from the runs record), if known. */
  runUrl?: string;
}

export type ActionStatus =
  | "reviewed"
  | "no_preview"
  | "unverified_preview"
  | "engine_error"
  | "stale_discarded";

export interface ActionOutcome {
  status: ActionStatus;
  conclusion: CheckRunConclusion;
  commentAction?: "created" | "updated" | "skipped_stale";
  notReviewed?: string;
}

function neutralCheckRun(title: string, summary: string): CheckRun {
  return { name: "Apature Gate", conclusion: "neutral", title, summary };
}

async function isCurrentHead(ctx: ActionRunContext, deps: ActionRunDeps): Promise<boolean> {
  return (await deps.getCurrentHeadSha()) === ctx.pullRequest.headSha;
}

export async function runAction(
  config: NormalizedDesignReviewConfig,
  inputs: ActionRunInputs,
  ctx: ActionRunContext,
  deps: ActionRunDeps,
): Promise<ActionOutcome> {
  const publishMode = config.rules.gate === "blockers" ? "blocking" : "advisory";

  // 1. Resolve the preview URL (explicit -> template -> provider-bot -> local).
  const resolved = resolvePreviewUrl(
    {
      explicitUrl: inputs.previewUrl,
      prNumber: ctx.pullRequest.number,
      headSha: ctx.pullRequest.headSha,
      comments: ctx.previewComments,
      previewCommand: inputs.previewCommand,
      localServeUrl: inputs.localServeUrl,
    },
    config,
  );
  if (!resolved.ok) {
    if (!(await isCurrentHead(ctx, deps))) {
      return { status: "stale_discarded", conclusion: "neutral" };
    }
    await deps.publishCheckRun(
      neutralCheckRun("No preview", `No preview URL was found, so the review was skipped. ${resolved.reason}`),
    );
    return { status: "no_preview", conclusion: "neutral" };
  }

  // 2. Verify the preview source before any engine handoff.
  const verified = verifyPreviewHandoff({
    url: resolved.resolution.url,
    source: resolved.resolution.source,
    provider: resolved.resolution.provider,
    isFork: ctx.isFork,
    protectionBypassSecretName: config.preview.protectionBypassSecretName,
    authStateSecretName: config.preview.authStateSecretName,
  });
  if (!verified.ok) {
    if (!(await isCurrentHead(ctx, deps))) {
      return { status: "stale_discarded", conclusion: "neutral" };
    }
    await deps.publishCheckRun(
      neutralCheckRun("Preview not verified", `The preview source could not be verified (${verified.reason}); skipped.`),
    );
    return { status: "unverified_preview", conclusion: "neutral", notReviewed: verified.notReviewed };
  }

  const sanitizedConfig: NormalizedDesignReviewConfig = {
    ...config,
    preview: {
      ...config.preview,
      protectionBypassSecretName: verified.protectionBypassSecretName,
      authStateSecretName: verified.authStateSecretName,
    },
  };

  // 3. Submit the hosted engine job (async /jobs, never a long synchronous call).
  let outcome;
  try {
    outcome = await deps.engine.review({
      installationId: ctx.installationId,
      repository: ctx.repository,
      pullRequest: ctx.pullRequest,
      preview: { url: verified.url, provider: verified.provider, environment: config.preview.environment },
      config: sanitizedConfig,
      publishMode,
      depth: "deep",
    });
  } catch {
    // Engine unavailable / contract violation: neutral Check Run, never fail the PR.
    if (!(await isCurrentHead(ctx, deps))) {
      return { status: "stale_discarded", conclusion: "neutral" };
    }
    const failure = decideDeliveryForError("engine_unavailable");
    await deps.publishCheckRun({ name: "Apature Gate", ...failure.checkRun });
    return { status: "engine_error", conclusion: failure.checkRun.conclusion };
  }

  // 4. Map the outcome to a safe, non-blocking delivery decision.
  const decision = decideDelivery(outcome, {
    headSha: ctx.pullRequest.headSha,
    gate: config.rules.gate,
    runUrl: deps.runUrl,
  });

  // 5. Publish-time SHA guard: discard an older workflow after a newer push.
  if (!(await isCurrentHead(ctx, deps))) {
    return { status: "stale_discarded", conclusion: "neutral" };
  }

  // 6. Post the sticky comment (when there's a result) and the Check Run.
  let commentAction: ActionOutcome["commentAction"];
  if (decision.publishComment && decision.comment) {
    const upsert = await upsertStickyComment(deps.comments, decision.comment);
    commentAction = upsert.action;
  }
  await deps.publishCheckRun({ name: "Apature Gate", ...decision.checkRun });

  return { status: "reviewed", conclusion: decision.checkRun.conclusion, commentAction };
}
