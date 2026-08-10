import type { ReviewDepth } from "@gate/types";
import type { SqlQuery } from "./review-window.js";

/**
 * Durable completed-review store (TRD §5/§13/§15.2, #69). The hosted path
 * published comments/checks but never persisted a `runs` row, so the completed-
 * review identity wasn't durably idempotent, dashboard/billing queries stayed
 * empty, and the Postgres 10-minute full-review cap (`runs.last_full_review_at`)
 * was a no-op (the `UPDATE` hit zero rows). This store performs ONE upsert that
 * creates the completed run AND records `last_full_review_at` for deep reviews,
 * keyed on the repository-scoped completed-review identity (#65) so a retry of
 * the same repo/PR/head SHA never creates a second row or republishes.
 *
 * Gate stores only judgment metadata + lineage, never critique JSON or
 * screenshot bytes (those stay owned by verdict). Run it through the
 * installation-scoped (RLS) transaction helper in production.
 */
export interface CompletedRunRecord {
  installationId: string;
  owner: string;
  name: string;
  prNumber: number;
  headSha: string;
  grade: string;
  depth: ReviewDepth;
  engineVersion?: string | null;
  model?: string | null;
  uiDnaVersion?: string | null;
  /** Epoch ms when the full review ran; set for deep so the window is durable. */
  lastFullReviewAtMs?: number;
  /** Epoch ms when screenshots expire (retention); null = no expiry recorded. */
  expiresAtMs?: number | null;
}

export interface RunStore {
  /** Persist a completed review (idempotent on the completed-review identity). */
  recordCompletedRun(run: CompletedRunRecord): Promise<void>;
}

function runKey(r: Pick<CompletedRunRecord, "owner" | "name" | "prNumber" | "headSha">): string {
  return `${r.owner}/${r.name}#${r.prNumber}@${r.headSha}`;
}

/** In-memory RunStore for local dev + tests; mirrors the upsert idempotency. */
export function createInMemoryRunStore(): RunStore & { runs: Map<string, CompletedRunRecord> } {
  const runs = new Map<string, CompletedRunRecord>();
  return {
    runs,
    async recordCompletedRun(run) {
      const key = runKey(run);
      const prior = runs.get(key);
      // Preserve a prior deep timestamp if this upsert is a triage (no ts).
      const lastFullReviewAtMs = run.lastFullReviewAtMs ?? prior?.lastFullReviewAtMs;
      runs.set(key, { ...prior, ...run, lastFullReviewAtMs });
    },
  };
}

/**
 * Postgres RunStore: one `INSERT ... ON CONFLICT DO UPDATE` on the #65 identity.
 * `last_full_review_at` is COALESCE'd so a later triage upsert never clears a
 * prior deep timestamp (the durable 10-minute cap survives restarts).
 */
export function createSqlRunStore(query: SqlQuery): RunStore {
  return {
    async recordCompletedRun(run) {
      await query(
        `INSERT INTO runs
           (installation_id, repo_owner, repo_name, pr_number, head_sha,
            grade, engine_version, model, ui_dna_version, depth,
            last_full_review_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (repo_owner, repo_name, pr_number, head_sha) DO UPDATE SET
           grade = EXCLUDED.grade,
           engine_version = EXCLUDED.engine_version,
           model = EXCLUDED.model,
           ui_dna_version = EXCLUDED.ui_dna_version,
           depth = EXCLUDED.depth,
           last_full_review_at = COALESCE(EXCLUDED.last_full_review_at, runs.last_full_review_at),
           expires_at = COALESCE(EXCLUDED.expires_at, runs.expires_at)`,
        [
          run.installationId,
          run.owner,
          run.name,
          run.prNumber,
          run.headSha,
          run.grade,
          run.engineVersion ?? null,
          run.model ?? null,
          run.uiDnaVersion ?? null,
          run.depth,
          run.lastFullReviewAtMs ? new Date(run.lastFullReviewAtMs).toISOString() : null,
          run.expiresAtMs ? new Date(run.expiresAtMs).toISOString() : null,
        ],
      );
    },
  };
}
