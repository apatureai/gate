import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import {
  buildMeasurementBaseline,
  compareMeasurementsToBaseline,
  lookupMeasurementBaseline,
  MEASUREMENT_IDENTITY_VERSION,
} from "@gate/delivery";
import { loadGoldenReviewResult, type GateReviewResult, type Measurement } from "@gate/types";
import { beforeEach, describe, expect, it } from "vitest";
import { createSqlMeasurementBaselineStore } from "../src/measurement-baseline-store.js";

/**
 * The durable half of baseline scoping.
 *
 * The comparison is pure and tested next door; what is tested here is that a
 * measurement set survives a round trip through Postgres unchanged, that a
 * commit nobody has measured comes back as ABSENT rather than as empty, and that
 * a row Gate did not write in this process cannot smuggle a shape through
 * `jsonb` that makes a real violation look pre-existing.
 */

let db: PGlite;
const query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  db.query<T>(sql, params as unknown[]);

const key = { installationId: "1", owner: "acme", name: "web", commitSha: "basesha" };

const violation = (over: Partial<Measurement> = {}): Measurement => ({
  kind: "contrast",
  route: "/pricing",
  viewports: ["mobile"],
  element: "#hero-subtitle",
  detail: "text contrast 3.23:1 is below WCAG AA 4.5:1",
  blockEligible: true,
  ...over,
});

const resultWith = (violations: Measurement[]): GateReviewResult => ({
  ...loadGoldenReviewResult(),
  measurements: { checksRun: ["contrast", "overflow"], violations },
  coverage: {
    routesRequested: ["/pricing"],
    routesReviewed: ["/pricing"],
    viewportsRequested: ["mobile"],
    viewportsReviewed: ["mobile"],
  },
});

beforeEach(async () => {
  db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  await db.exec("INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10)");
});

describe("createSqlMeasurementBaselineStore", () => {
  it("round-trips a measurement set with its version, checks and routes", async () => {
    const store = createSqlMeasurementBaselineStore(query);
    const snapshot = buildMeasurementBaseline(resultWith([violation()]), {
      commitSha: "basesha",
      recordedAtMs: 1_700_000_000_000,
    });
    await store.record({ ...key, snapshot });

    const read = await store.find(key);
    expect(read).not.toBeNull();
    expect(read?.version).toBe(MEASUREMENT_IDENTITY_VERSION);
    expect(read?.commitSha).toBe("basesha");
    expect(read?.checksRun).toEqual(["contrast", "overflow"]);
    expect(read?.routesMeasured).toEqual(["/pricing"]);
    expect(read?.entries).toEqual(snapshot.entries);
    expect(read?.recordedAtMs).toBe(1_700_000_000_000);
  });

  it("returns null for a commit nothing has ever measured", async () => {
    const store = createSqlMeasurementBaselineStore(query);
    await store.record({ ...key, snapshot: buildMeasurementBaseline(resultWith([]), { commitSha: "basesha" }) });

    expect(await store.find({ ...key, commitSha: "never-seen" })).toBeNull();
    expect(await store.find({ ...key, name: "other-repo" })).toBeNull();
    expect(await store.find({ ...key, owner: "other-owner" })).toBeNull();
  });

  it("re-recording the same commit replaces the set in place", async () => {
    const store = createSqlMeasurementBaselineStore(query);
    await store.record({ ...key, snapshot: buildMeasurementBaseline(resultWith([violation()]), { commitSha: "basesha" }) });
    await store.record({
      ...key,
      snapshot: buildMeasurementBaseline(resultWith([violation(), violation({ element: "#b" })]), {
        commitSha: "basesha",
      }),
    });

    const rows = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM measurement_baselines",
    );
    expect(rows.rows[0]?.count).toBe("1");
    expect((await store.find(key))?.entries).toHaveLength(2);
  });

  it("survives a stored set from a commit that measured nothing", async () => {
    // An engine that reports no measurements at all. The row exists, and it must
    // come back saying "nothing was measured" rather than "nothing was wrong".
    const store = createSqlMeasurementBaselineStore(query);
    await store.record({
      ...key,
      snapshot: buildMeasurementBaseline(loadGoldenReviewResult(), { commitSha: "basesha" }),
    });

    const read = await store.find(key);
    expect(read?.checksRun).toEqual([]);
    expect(read?.routesMeasured).toEqual([]);

    // ...and a violation compared against it is unclassified, never introduced.
    const comparison = compareMeasurementsToBaseline(resultWith([violation()]), {
      lookup: { status: "found", snapshot: read as NonNullable<typeof read> },
    });
    expect(comparison.introduced).toEqual([]);
    // Neither the route nor the check is on record; the route is reported first
    // because it is the more actionable of the two.
    expect(comparison.classified[0]?.reason).toBe("route_not_measured");
  });

  it("drops jsonb entries it cannot recognise instead of trusting them", async () => {
    // A malformed entry that survived into the fingerprint set would silently
    // make a real violation look pre-existing, so the reader is strict.
    await db.query(
      `INSERT INTO measurement_baselines
         (installation_id, repo_owner, repo_name, commit_sha, fingerprint_version,
          checks_run, routes_measured, entries)
       VALUES (1, 'acme', 'web', 'basesha', 'm1',
         '["contrast", "nonsense"]'::jsonb, '["/pricing", 7]'::jsonb,
         '[{"kind":"contrast","route":"/pricing","elementKey":"k","fingerprint":"f"},
           {"kind":"nonsense","route":"/pricing","elementKey":"k","fingerprint":"f"},
           {"kind":"contrast","route":"/pricing"},
           "not-an-object", null]'::jsonb)`,
    );

    const read = await createSqlMeasurementBaselineStore(query).find(key);
    expect(read?.checksRun).toEqual(["contrast"]);
    expect(read?.routesMeasured).toEqual(["/pricing"]);
    expect(read?.entries).toEqual([
      { kind: "contrast", route: "/pricing", elementKey: "k", fingerprint: "f" },
    ]);
  });

  it("is read through lookupMeasurementBaseline as found or absent, never as clean", async () => {
    const store = createSqlMeasurementBaselineStore(query);
    expect((await lookupMeasurementBaseline(store, key)).status).toBe("absent");

    await store.record({ ...key, snapshot: buildMeasurementBaseline(resultWith([]), { commitSha: "basesha" }) });
    expect((await lookupMeasurementBaseline(store, key)).status).toBe("found");
  });
});
