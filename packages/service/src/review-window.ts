import type { ReviewDepth } from "@gate/types";
import { reviewQueueKey } from "./queue.js";
import type { RepoPr } from "./supersession.js";

/**
 * 10-minute full-review cap (TRD §3.2, §6.2; §15.2). At most one full (deep)
 * review per PR per 10 minutes; re-pushes inside the window run the cheap triage
 * pass. The window is tracked durably in Postgres (`runs.last_full_review_at`),
 * NOT a Redis delayed job — a Fly restart must not reset the cap and allow more
 * than one full review per window. The cap also surfaces as the poll-loop
 * deadline (#45).
 */
export const FULL_REVIEW_WINDOW_MS = 10 * 60 * 1000;

/** Triage if a full review ran within the window, else deep. */
export function chooseReviewDepth(
  lastFullReviewAtMs: number | null,
  now: number = Date.now(),
  windowMs: number = FULL_REVIEW_WINDOW_MS,
): ReviewDepth {
  if (lastFullReviewAtMs !== null && now - lastFullReviewAtMs < windowMs) return "triage";
  return "deep";
}

export interface FullReviewWindowStore {
  getLastFullReviewAt(repo: RepoPr): Promise<number | null>;
  recordFullReview(repo: RepoPr, atMs: number): Promise<void>;
}

/** Decide the depth for a new push based on the PR's last full review. */
export async function decideDepthForPush(
  store: FullReviewWindowStore,
  repo: RepoPr,
  now: number = Date.now(),
): Promise<ReviewDepth> {
  return chooseReviewDepth(await store.getLastFullReviewAt(repo), now);
}

export function createInMemoryFullReviewWindow(): FullReviewWindowStore {
  const map = new Map<string, number>();
  const k = (repo: RepoPr): string => reviewQueueKey(repo.owner, repo.name, repo.prNumber);
  return {
    async getLastFullReviewAt(repo) {
      return map.get(k(repo)) ?? null;
    },
    async recordFullReview(repo, atMs) {
      map.set(k(repo), atMs);
    },
  };
}

export interface SqlQuery {
  <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Postgres-backed window using the durable `runs.last_full_review_at` column. */
export function createSqlFullReviewWindow(query: SqlQuery): FullReviewWindowStore {
  return {
    async getLastFullReviewAt(repo) {
      const { rows } = await query<{ last_full_review_at: string | null }>(
        `SELECT last_full_review_at FROM runs
           WHERE repo_owner = $1 AND repo_name = $2 AND pr_number = $3
             AND last_full_review_at IS NOT NULL
           ORDER BY last_full_review_at DESC LIMIT 1`,
        [repo.owner, repo.name, repo.prNumber],
      );
      const value = rows[0]?.last_full_review_at;
      return value ? new Date(value).getTime() : null;
    },
    async recordFullReview(repo, atMs) {
      await query(
        `UPDATE runs SET last_full_review_at = $4
           WHERE repo_owner = $1 AND repo_name = $2 AND pr_number = $3`,
        [repo.owner, repo.name, repo.prNumber, new Date(atMs).toISOString()],
      );
    },
  };
}
