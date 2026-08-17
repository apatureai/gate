import {
  type CheckRun,
  type CheckRunConclusion,
  type CoverageState,
  decideDelivery,
  decideDeliveryForError,
  type GitHubCommentsApi,
  type JudgmentState,
  suppressesGrade,
  suppressesGradeForCoverage,
  upsertStickyComment,
} from "@gate/delivery";
import {
  assertReviewOutcomeIdentity,
  classifyEngineFailure,
  type EngineFailureKind,
  type JudgmentEngineClient,
  verifyPreviewHandoff,
} from "@gate/engine";
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
  /**
   * Component-library ids detected in the checked-out repository, forwarded to
   * the engine so its deep prompt carries the matching rubric addendum.
   * Optional and additive: a run that detected nothing sends nothing, and the
   * review is grounded on tokens and brand exactly as it was before.
   */
  componentLibraries?: string[];
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
  /**
   * The engine returned a complete result and stated that nothing judged the
   * page (no model configured, so a deterministic stand-in filled the critique).
   * Distinct from `reviewed` on purpose: the run log, the Check Run and the
   * sticky comment must not all call this a review when it was not one.
   */
  | "not_judged"
  /**
   * The engine returned a complete result and stated that it reviewed NOTHING:
   * no requested route reached a judgment (verdict#165). Distinct from
   * `not_judged`, which is about whether a MODEL ran; this is about whether it
   * ran on anything. An empty capture yields an honest `model_backed: true` and
   * a `ship` grade over zero pages, and logging that as `reviewed` while the
   * Check Run goes neutral is exactly the disagreement Gate is closing.
   */
  | "nothing_reviewed"
  | "no_preview"
  | "unverified_preview"
  /** The engine could not be reached, or failed in a way a retry can clear. */
  | "engine_error"
  /**
   * The engine answered and refused the request: wrong shared secret, unknown
   * installation, wrong endpoint. Separate from `engine_error` because nothing
   * about waiting fixes it, and the operator has to be told which.
   */
  | "engine_rejected"
  /** The idempotency key for this (pr, head_sha) was spent on a different request. */
  | "idempotency_conflict"
  | "stale_discarded";

export interface ActionOutcome {
  status: ActionStatus;
  conclusion: CheckRunConclusion;
  commentAction?: "created" | "updated" | "skipped_stale";
  notReviewed?: string;
  /** Engine's judgment attestation for a completed result (`decideDelivery`). */
  judgment?: JudgmentState;
  /** How much of the requested review actually happened (verdict#165). */
  coverage?: CoverageState;
}

/** One engine-failure kind, one run status, so the log says what the Check Run says. */
const ENGINE_FAILURE_STATUS: Record<EngineFailureKind, ActionStatus> = {
  engine_unavailable: "engine_error",
  engine_rejected: "engine_rejected",
  idempotency_conflict: "idempotency_conflict",
};

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
          "Local preview is disabled for fork PRs; set `fork_preview: true` in .gate.yml to enable.",
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
        ...(ctx.componentLibraries && ctx.componentLibraries.length > 0
          ? { componentLibraries: ctx.componentLibraries }
          : {}),
      });
      assertReviewOutcomeIdentity(outcome, ctx);
    } catch (err) {
      // Engine unavailable / rejected / contract violation: neutral Check Run,
      // never fail the PR. The engine's own reason is logged AND published: the
      // bare `catch {}` that used to be here threw away
      // `engine submit failed: 401 (signature_mismatch)` one line before the
      // handler told the operator to wait for an outage that was never going to
      // end.
      const failure = classifyEngineFailure(err);
      console.error(`[gate] engine call failed (${failure.kind}): ${failure.message}`);
      if (!(await isCurrentHead(ctx, deps))) {
        return { status: "stale_discarded", conclusion: "neutral" };
      }
      const delivery = decideDeliveryForError(failure.kind, {
        code: failure.code,
        status: failure.status,
      });
      await deps.publishCheckRun({ name: "Apature Gate", ...delivery.checkRun });
      return { status: ENGINE_FAILURE_STATUS[failure.kind], conclusion: delivery.checkRun.conclusion };
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

    // The run log states what the Check Run states. `nothing_reviewed` is
    // reported ahead of `not_judged` for the same reason the Check Run titles it
    // first: it is the stronger fact, and an operator whose capture produced no
    // pages is not helped by hearing about a missing stamp instead.
    const judged = !decision.judgment || !suppressesGrade(decision.judgment);
    const reviewedNothing =
      decision.coverage !== undefined && suppressesGradeForCoverage(decision.coverage);
    const status: ActionStatus = reviewedNothing
      ? "nothing_reviewed"
      : judged
        ? "reviewed"
        : "not_judged";
    return {
      status,
      conclusion: decision.checkRun.conclusion,
      commentAction,
      ...(decision.judgment ? { judgment: decision.judgment } : {}),
      ...(decision.coverage ? { coverage: decision.coverage } : {}),
    };
  } finally {
    // Always tear down the local server (every return path above + any throw).
    if (server) await server.stop();
  }
}
