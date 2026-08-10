import { deriveArtifactId, type Finding, type GateReviewResult } from "@gate/types";

/**
 * Run history + finding browser data layer (TRD §13, §8). Gate stores run
 * metadata in Postgres (findings/screenshots are engine-owned artifacts
 * referenced by the stable `/i/<id>.png` route, #12). These query + view-model
 * helpers feed the dashboard pages; the React rendering is a thin consumer.
 */
export interface SqlQuery {
  <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface RunSummary {
  id: string;
  prNumber: number;
  headSha: string;
  grade: string | null;
  model: string | null;
  engineVersion: string | null;
  uiDnaVersion: string | null;
  createdAt: string;
}

interface RunRow {
  id: string;
  pr_number: number;
  head_sha: string;
  grade: string | null;
  model: string | null;
  engine_version: string | null;
  ui_dna_version: string | null;
  created_at: string | Date;
}

/** Per-repo run history, newest first. Runs under a tenant-scoped query (RLS). */
export async function listRunHistory(
  query: SqlQuery,
  params: { owner: string; name: string; limit?: number },
): Promise<RunSummary[]> {
  const { rows } = await query<RunRow>(
    `SELECT id, pr_number, head_sha, grade, model, engine_version, ui_dna_version, created_at
       FROM runs
       WHERE repo_owner = $1 AND repo_name = $2
       ORDER BY created_at DESC
       LIMIT $3`,
    [params.owner, params.name, params.limit ?? 50],
  );
  return rows.map((r) => ({
    id: r.id,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    grade: r.grade,
    model: r.model,
    engineVersion: r.engine_version,
    uiDnaVersion: r.ui_dna_version,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** GitHub PR URL a run links back to. */
export function prUrl(owner: string, name: string, prNumber: number): string {
  return `https://github.com/${owner}/${name}/pull/${prNumber}`;
}

function stableScreenshotUrl(baseUrl: string, artifactId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/i/${artifactId}.png`;
}

export interface FindingView extends Finding {
  /** Stable annotated-screenshot URL, or null when none. */
  screenshotUrl: string | null;
}

export interface FindingBrowser {
  prUrl: string;
  grade: string;
  overall: string;
  findings: FindingView[];
}

/**
 * Build the per-run finding browser from an engine result. Screenshot URLs use
 * the collision-safe artifact id (#71), derived from the run's
 * installation/repo/head-SHA + finding id, so they match the registry's stable
 * route exactly and never collide across runs/repos (requires `installationId`
 * + `headSha` in the context).
 */
export function buildFindingBrowser(
  result: GateReviewResult,
  ctx: { baseUrl: string; installationId: string; owner: string; name: string; prNumber: number; headSha: string },
): FindingBrowser {
  const annotated = new Set(result.artifacts.annotatedScreenshots.map((s) => s.findingId));
  return {
    prUrl: prUrl(ctx.owner, ctx.name, ctx.prNumber),
    grade: result.grade,
    overall: result.overall,
    findings: result.findings.map((f) => ({
      ...f,
      screenshotUrl: annotated.has(f.id)
        ? stableScreenshotUrl(
            ctx.baseUrl,
            deriveArtifactId({
              installationId: ctx.installationId,
              owner: ctx.owner,
              name: ctx.name,
              headSha: ctx.headSha,
              findingId: f.id,
            }),
          )
        : null,
    })),
  };
}
