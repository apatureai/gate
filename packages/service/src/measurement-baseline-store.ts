import type {
  MeasurementBaselineEntry,
  MeasurementBaselineKey,
  MeasurementBaselineRecord,
  MeasurementBaselineSnapshot,
  MeasurementBaselineStore,
} from "@gate/delivery";
import type { MeasurementKind } from "@gate/types";
import type { SqlQuery } from "./review-window.js";

/**
 * Postgres binding for the per-commit measurement set (`measurement_baselines`).
 *
 * The pure comparison and the store INTERFACE live in `@gate/delivery`, beside
 * the code that reads them, because both delivery paths need the interface and
 * only one of them has a database: the hosted App path binds this, and the
 * Action path binds nothing unless an operator hands it a store. A path with no
 * store classifies nothing and therefore gates nothing, and says which of those
 * two things happened.
 *
 * Run it inside the installation-scoped (RLS) transaction helper in production,
 * exactly like `createSqlRunStore`: the table default-denies without a tenant
 * GUC, so an unscoped query reads nothing rather than reading everything.
 */

/** One `INSERT ... ON CONFLICT DO UPDATE` per completed review, on (repo, commit). */
export function createSqlMeasurementBaselineStore(query: SqlQuery): MeasurementBaselineStore {
  return {
    async record(record: MeasurementBaselineRecord) {
      const snapshot = record.snapshot;
      await query(
        `INSERT INTO measurement_baselines
           (installation_id, repo_owner, repo_name, commit_sha,
            fingerprint_version, engine_version, checks_run, routes_measured, entries, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
         ON CONFLICT (repo_owner, repo_name, commit_sha) DO UPDATE SET
           fingerprint_version = EXCLUDED.fingerprint_version,
           engine_version = EXCLUDED.engine_version,
           checks_run = EXCLUDED.checks_run,
           routes_measured = EXCLUDED.routes_measured,
           entries = EXCLUDED.entries,
           recorded_at = EXCLUDED.recorded_at`,
        [
          record.installationId,
          record.owner,
          record.name,
          record.commitSha,
          snapshot.version,
          snapshot.engineVersion ?? null,
          JSON.stringify(snapshot.checksRun),
          JSON.stringify(snapshot.routesMeasured),
          JSON.stringify(snapshot.entries),
          new Date(snapshot.recordedAtMs ?? Date.now()).toISOString(),
        ],
      );
    },

    async find(key: MeasurementBaselineKey): Promise<MeasurementBaselineSnapshot | null> {
      const { rows } = await query<{
        commit_sha: string;
        fingerprint_version: string;
        engine_version: string | null;
        checks_run: unknown;
        routes_measured: unknown;
        entries: unknown;
        recorded_at: Date | string | null;
      }>(
        `SELECT commit_sha, fingerprint_version, engine_version, checks_run, routes_measured,
                entries, recorded_at
           FROM measurement_baselines
          WHERE repo_owner = $1 AND repo_name = $2 AND commit_sha = $3`,
        [key.owner, key.name, key.commitSha],
      );
      const row = rows[0];
      if (!row) return null;
      const recordedAtMs = row.recorded_at ? new Date(row.recorded_at).getTime() : undefined;
      return {
        version: row.fingerprint_version,
        commitSha: row.commit_sha,
        checksRun: asKinds(row.checks_run),
        routesMeasured: asStrings(row.routes_measured),
        entries: asEntries(row.entries),
        engineVersion: row.engine_version,
        ...(recordedAtMs !== undefined && Number.isFinite(recordedAtMs) ? { recordedAtMs } : {}),
      };
    },
  };
}

/**
 * jsonb comes back as `unknown`, and a row written by an older or a future
 * version of this code is data Gate did not produce in this process. Every
 * reader below drops what it cannot recognise instead of trusting the shape:
 * a malformed entry that survived into the fingerprint set would silently make
 * a real violation look pre-existing.
 */
function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const KINDS: readonly MeasurementKind[] = ["contrast", "overflow", "touch_target"];

function asKinds(value: unknown): MeasurementKind[] {
  return asStrings(value).filter((item): item is MeasurementKind =>
    (KINDS as readonly string[]).includes(item),
  );
}

function asEntries(value: unknown): MeasurementBaselineEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: MeasurementBaselineEntry[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const kind = row.kind;
    const route = row.route;
    const elementKey = row.elementKey;
    const fingerprint = row.fingerprint;
    // `defectKey` is required like the other two. A row missing it was written
    // by a build that predates the markup-refactor tier, and that build stamped
    // a different `fingerprint_version`, so the whole snapshot is refused as
    // skewed before an entry is ever read. Accepting a keyless entry here would
    // instead leave a live one that no refactor can ever claim, which is the
    // failure this tier exists to remove, restored one row at a time.
    const defectKey = row.defectKey;
    if (
      typeof kind !== "string" ||
      !(KINDS as readonly string[]).includes(kind) ||
      typeof route !== "string" ||
      typeof elementKey !== "string" ||
      typeof fingerprint !== "string" ||
      typeof defectKey !== "string"
    ) {
      continue;
    }
    // `severity` is the opposite case from `defectKey`, and it is optional for a
    // reason the rest of this reader shares: a row written before the band
    // existed carries no band, was stamped with the SAME identity version
    // (identity did not change when the band was added), and is therefore
    // compared normally. It has to come back as absent, which reads as unknown
    // and gates on nothing. Anything that is not a positive integer is dropped
    // to absent for the same reason: a `0`, a `2.91` or a `"3"` that reached
    // jsonb is not a band, and reading one as a band would compare this run
    // against a number nothing produced.
    const severity = row.severity;
    const banded =
      typeof severity === "number" && Number.isInteger(severity) && severity > 0
        ? { severity }
        : {};
    entries.push({
      kind: kind as MeasurementKind,
      route,
      elementKey,
      fingerprint,
      defectKey,
      ...banded,
    });
  }
  return entries;
}
