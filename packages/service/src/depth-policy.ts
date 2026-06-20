import { getTracer } from "@gate/observability";
import type { ReviewDepth } from "@gate/types";
import { chooseReviewDepth, FULL_REVIEW_WINDOW_MS, type FullReviewWindowStore } from "./review-window.js";
import type { RepoPr } from "./supersession.js";

/**
 * Review-depth signaling policy (TRD §5, §6, §15.1; PRD §6). Gate chooses
 * `triage` vs `deep` per push from the 10-minute full-review cap (#7) and carries
 * it in the `POST /jobs` body (#45). Depth-aware poll backoff is in #45;
 * engine-side model routing is an engine concern. Decisions are traced for
 * tuning. This composes with per-`(repo,pr)` concurrency (#6) and supersession
 * (#4): they constrain *whether/when* a job runs; this only sets its depth.
 */
export type DepthReason =
  | "no_prior_full_review"
  | "within_full_review_window"
  | "full_review_window_elapsed";

export interface DepthDecision {
  depth: ReviewDepth;
  reason: DepthReason;
  lastFullReviewAt: number | null;
}

export async function decideReviewDepth(
  store: FullReviewWindowStore,
  repo: RepoPr,
  now: number = Date.now(),
  windowMs: number = FULL_REVIEW_WINDOW_MS,
): Promise<DepthDecision> {
  const lastFullReviewAt = await store.getLastFullReviewAt(repo);
  const depth = chooseReviewDepth(lastFullReviewAt, now, windowMs);
  const reason: DepthReason =
    lastFullReviewAt === null
      ? "no_prior_full_review"
      : depth === "triage"
        ? "within_full_review_window"
        : "full_review_window_elapsed";
  return { depth, reason, lastFullReviewAt };
}

/** Record the full-review timestamp only when a deep review was chosen. */
export async function recordFullReviewIfDeep(
  store: FullReviewWindowStore,
  repo: RepoPr,
  depth: ReviewDepth,
  atMs: number,
): Promise<void> {
  if (depth === "deep") await store.recordFullReview(repo, atMs);
}

/** Emit an OTel span recording the depth decision (for tuning). */
export function traceDepthDecision(repo: RepoPr, decision: DepthDecision): void {
  const span = getTracer().startSpan("gate.depth.decision");
  span.setAttribute("gate.depth", decision.depth);
  span.setAttribute("gate.depth_reason", decision.reason);
  span.setAttribute("gate.repo", `${repo.owner}/${repo.name}#${repo.prNumber}`);
  span.end();
}
