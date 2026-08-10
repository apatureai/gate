import {
  type CheckRun,
  type CheckRunConclusion,
  decideDelivery,
  decideDeliveryForError,
  type GitHubCommentsApi,
  upsertStickyComment,
} from "@gate/delivery";
import { assertReviewOutcomeIdentity, type JudgmentEngineClient, verifyPreviewHandoff } from "@gate/engine";
import { scrubTail } from "@gate/secrets";
import type { NormalizedDesignReviewConfig } from "@gate/types";
import type { PreviewBuildFact } from "@gate/types";
import { type ProviderComment, resolvePreviewUrl } from "./preview.js";
import type { LocalServerHandle, LocalServerStartResult } from "./local-serve.js";
import { parsePreviewBuildFacts } from "./build-facts.js";

/**
 * Injected local-serve supervisor (#70). `cwd` + the allowlisted `env` are
 * pre-bound by the entrypoint (main.ts) so orchestration stays free of process
 * reads and is testable with a fake. Returns the start result; the caller
 * tears down via the handle's `stop()` in a `finally`.
 */
export type StartLocalServerFn = (
  command: string,
  opts: { url: string; readyPath?: string | null; readyStatus?: number[] | null },
) => Promise<LocalServerStartResult>;

/** Human reason per local-serve failure; the raw child output goes to the Action log, not the PR. */
function localFailureSummary(result: Extract<LocalServerStartResult, { ok: false }>): string {
  switch (result.reason) {
    case "spawn_failed":
      return "The preview-command failed to launch. See the Action log for details.";
    case "early_exit":
      return "The preview server exited before it was ready. See the Action log for the command output.";
    case "redirected_off_loopback":
      return "The preview server redirected off localhost; it was refused for safety.";
    case "not_ready":
    default:
      return "The preview server did not become ready in time. See the Action log for the command output.";
  }
}

/** Max scrubbed tail length surfaced on the PR Check Run (the full tail goes to the Action log). */
const CHECK_RUN_TAIL_LEN = 2000;

/**
 * Build the failure Check Run summary: the human reason plus, when there is
 * command output, a secret-scrubbed + length-capped tail fenced and labeled as
 * untrusted (#78). The raw tail still goes to the Action log; only the scrubbed
 * form is allowed onto the PR.
 */
function localFailureCheckRunSummary(result: Extract<LocalServerStartResult, { ok: false }>): string {
  const reason = localFailureSummary(result);
  if (!result.tail || result.tail.trim().length === 0) return reason;
  const tail = scrubTail(result.tail, CHECK_RUN_TAIL_LEN);
  return `${reason}\n\nPreview-command output (untrusted, secrets scrubbed):\n\`\`\`\n${tail}\n\`\`\``;
}

/**
 * Action-path orchestration (TRD §2, §4, §7): resolve a preview URL, verify its
 * source, submit a hosted engine job via the async /jobs API, then post the
 * sticky comment and an advisory Check Run. Capture/annotation happen
 * engine-side; the runner only hands over a verified URL. Judgment-only: it never
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
  /** Local build-and-serve supervisor (#70); wired by main.ts for the local-serve path. */
  startLocalServer?: StartLocalServerFn;
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

  // 2b. Local build-and-serve (#70): when the preview was resolved by running the
  // repo's preview-command, actually start + supervise that server before handoff
  // and guarantee teardown. Higher-priority sources (explicit/template/bot)
  // never reach here with source "local", so they never spawn anything.
  let server: LocalServerHandle | null = null;
  let previewBuildFacts: PreviewBuildFact[] | undefined;
  if (resolved.resolution.source === "local" && deps.startLocalServer && inputs.previewCommand) {
    // Fork gate: running a fork's long-lived server under the app identity is the
    // repo owner's explicit opt-in. Same-repo PRs always run.
    if (ctx.isFork && !config.preview.forkPreview) {
      if (!(await isCurrentHead(ctx, deps))) return { status: "stale_discarded", conclusion: "neutral" };
      await deps.publishCheckRun(
        neutralCheckRun(
          "Preview skipped on fork",
          "Local preview is disabled for fork PRs; set `fork_preview: true` in .designreview.yml to enable.",
        ),
      );
      return { status: "no_preview", conclusion: "neutral", notReviewed: "fork preview disabled" };
    }

    const started = await deps.startLocalServer(inputs.previewCommand, {
      url: verified.url,
      readyPath: config.preview.readyPath,
      readyStatus: config.preview.readyStatus,
    });
    if (!started.ok) {
      if (started.tail) console.error(`[gate] preview-command output (untrusted):\n${started.tail}`);
      if (!(await isCurrentHead(ctx, deps))) return { status: "stale_discarded", conclusion: "neutral" };
      await deps.publishCheckRun(neutralCheckRun("Preview not ready", localFailureCheckRunSummary(started)));
      return { status: "no_preview", conclusion: "neutral", notReviewed: started.reason };
    }
    server = started.server;
    // U1: turn the build/boot log into grounded facts for the engine critique.
    const facts = parsePreviewBuildFacts(server.output());
    if (facts.length > 0) previewBuildFacts = facts;
  }

  try {
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
        ...(previewBuildFacts ? { previewBuildFacts } : {}),
      });
      assertReviewOutcomeIdentity(outcome, ctx);
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
      minSeverityToComment: config.rules.minSeverityToComment,
      suppress: config.rules.suppress,
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
  } finally {
    // Always tear down the local server (every return path above + any throw).
    if (server) await server.stop();
  }
}
