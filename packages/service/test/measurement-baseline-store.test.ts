import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import {
  buildMeasurementBaseline,
  carryMeasurementBaselineForward,
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
    // make a real violation look pre-existing, so the reader is strict. An entry
    // missing `defectKey` is malformed for the same reason: it is an entry no
    // markup refactor could ever claim, which is the failure the third tier
    // exists to remove.
    await db.query(
      `INSERT INTO measurement_baselines
         (installation_id, repo_owner, repo_name, commit_sha, fingerprint_version,
          checks_run, routes_measured, entries)
       VALUES (1, 'acme', 'web', 'basesha', 'm1',
         '["contrast", "nonsense"]'::jsonb, '["/pricing", 7]'::jsonb,
         '[{"kind":"contrast","route":"/pricing","elementKey":"k","fingerprint":"f","defectKey":"d"},
           {"kind":"nonsense","route":"/pricing","elementKey":"k","fingerprint":"f","defectKey":"d"},
           {"kind":"contrast","route":"/pricing","elementKey":"k","fingerprint":"f"},
           {"kind":"contrast","route":"/pricing"},
           "not-an-object", null]'::jsonb)`,
    );

    const read = await createSqlMeasurementBaselineStore(query).find(key);
    expect(read?.checksRun).toEqual(["contrast"]);
    expect(read?.routesMeasured).toEqual(["/pricing"]);
    expect(read?.entries).toEqual([
      { kind: "contrast", route: "/pricing", elementKey: "k", fingerprint: "f", defectKey: "d" },
    ]);
  });

  it("is read through lookupMeasurementBaseline as found or absent, never as clean", async () => {
    const store = createSqlMeasurementBaselineStore(query);
    expect((await lookupMeasurementBaseline(store, key)).status).toBe("absent");

    await store.record({ ...key, snapshot: buildMeasurementBaseline(resultWith([]), { commitSha: "basesha" }) });
    expect((await lookupMeasurementBaseline(store, key)).status).toBe("found");
  });

  it("keeps a carried set distinguishable from an observed one across the round trip", async () => {
    // A row copied onto a merge commit whose tree was identical to the tree that
    // was measured. It has to come back saying which commit was RENDERED, or an
    // audit cannot tell a fact Gate observed from one it deduced.
    const store = createSqlMeasurementBaselineStore(query);
    const observed = buildMeasurementBaseline(resultWith([violation()]), { commitSha: "headsha" });
    await store.record({ ...key, commitSha: "headsha", snapshot: observed });
    await store.record({
      ...key,
      commitSha: "mergesha",
      snapshot: carryMeasurementBaselineForward(observed, {
        commitSha: "mergesha",
        recordedAtMs: 1_700_000_001_000,
      }),
    });

    const carried = await store.find({ ...key, commitSha: "mergesha" });
    expect(carried?.carriedFrom).toBe("headsha");
    expect(carried?.commitSha).toBe("mergesha");
    // Nothing re-derived: identity version, engine version and every entry are
    // the ones the measurements were computed under.
    expect(carried?.version).toBe(observed.version);
    expect(carried?.engineVersion).toBe(observed.engineVersion);
    expect(carried?.entries).toEqual(observed.entries);
    expect(carried?.checksRun).toEqual(observed.checksRun);
    expect(carried?.recordedAtMs).toBe(1_700_000_001_000);

    // An observed row says nothing about being carried, and neither does a row
    // written before the column existed.
    expect((await store.find({ ...key, commitSha: "headsha" }))?.carriedFrom).toBeUndefined();
  });

  it("reads a row written before carried_from existed as observed, not as carried", async () => {
    await db.query(
      `INSERT INTO measurement_baselines
         (installation_id, repo_owner, repo_name, commit_sha, fingerprint_version, entries)
       VALUES (1, 'acme', 'web', 'basesha', $1, '[]'::jsonb)`,
      [MEASUREMENT_IDENTITY_VERSION],
    );
    expect((await createSqlMeasurementBaselineStore(query).find(key))?.carriedFrom).toBeUndefined();
  });

  it("re-recording a commit that was carried can restore it to observed", async () => {
    // If a review ever DOES measure the merge commit itself, the observed set
    // replaces the deduced one, and the row must stop claiming it was carried.
    const store = createSqlMeasurementBaselineStore(query);
    const observed = buildMeasurementBaseline(resultWith([violation()]), { commitSha: "mergesha" });
    await store.record({
      ...key,
      commitSha: "mergesha",
      snapshot: carryMeasurementBaselineForward(observed, { commitSha: "mergesha" }),
    });
    expect((await store.find({ ...key, commitSha: "mergesha" }))?.carriedFrom).toBe("mergesha");

    await store.record({ ...key, commitSha: "mergesha", snapshot: observed });
    expect((await store.find({ ...key, commitSha: "mergesha" }))?.carriedFrom).toBeUndefined();
  });
});

describe("where a stored set was rendered survives the round trip", () => {
  /**
   * The column exists so a comparison can tell whether its two sides are
   * comparable at all: a set measured at `preview.default_branch_url` against a
   * pull request measured at its own preview is production against a preview,
   * and a difference between those is not the pull request's doing. A row that
   * cannot say where it was rendered leaves the comparison no way to ask.
   */
  it("keeps the surface and the origin", async () => {
    const store = createSqlMeasurementBaselineStore(query);
    await store.record({
      ...key,
      snapshot: buildMeasurementBaseline(resultWith([violation()]), {
        commitSha: "basesha",
        measuredAt: { surface: "default_branch", origin: "https://app.example.com" },
      }),
    });

    expect((await store.find(key))?.measuredAt).toEqual({
      surface: "default_branch",
      origin: "https://app.example.com",
    });
  });

  it("keeps the surface when there was no address to record", async () => {
    const store = createSqlMeasurementBaselineStore(query);
    await store.record({
      ...key,
      snapshot: buildMeasurementBaseline(resultWith([violation()]), {
        commitSha: "basesha",
        measuredAt: { surface: "pull_request_preview" },
      }),
    });

    expect((await store.find(key))?.measuredAt).toEqual({ surface: "pull_request_preview" });
  });

  it("comes back ABSENT for a row written before the column existed", async () => {
    // Which is unknown, and unknown is compared normally. Reading a NULL as a
    // difference would have switched attribution off for every baseline in the
    // field on the day the column shipped.
    const store = createSqlMeasurementBaselineStore(query);
    await store.record({
      ...key,
      snapshot: buildMeasurementBaseline(resultWith([violation()]), { commitSha: "basesha" }),
    });
    await db.exec("UPDATE measurement_baselines SET measured_at_surface = NULL, measured_at_origin = NULL");

    expect((await store.find(key))?.measuredAt).toBeUndefined();
  });

  it("drops a surface this build does not recognise, rather than trusting the string", async () => {
    // Same rule every other reader here follows: a row a future or a foreign
    // build wrote is data this process did not produce, and a value it cannot
    // interpret must not become evidence that two deployments differ.
    const store = createSqlMeasurementBaselineStore(query);
    await store.record({
      ...key,
      snapshot: buildMeasurementBaseline(resultWith([violation()]), {
        commitSha: "basesha",
        measuredAt: { surface: "default_branch", origin: "https://app.example.com" },
      }),
    });
    await db.exec("UPDATE measurement_baselines SET measured_at_surface = 'staging_replica'");

    expect((await store.find(key))?.measuredAt).toBeUndefined();
  });

  it("drops an origin with no surface, because an origin alone answers nothing", async () => {
    const store = createSqlMeasurementBaselineStore(query);
    await store.record({
      ...key,
      snapshot: buildMeasurementBaseline(resultWith([violation()]), { commitSha: "basesha" }),
    });
    await db.exec("UPDATE measurement_baselines SET measured_at_origin = 'https://app.example.com'");

    expect((await store.find(key))?.measuredAt).toBeUndefined();
  });

  it("carries the source's environment onto a carried set, not the merge's own", async () => {
    // The property that makes a carried set the better baseline: it describes a
    // rendering that happened at a preview, and copying it across two identical
    // trees did not move it anywhere.
    const store = createSqlMeasurementBaselineStore(query);
    const head = buildMeasurementBaseline(resultWith([violation()]), {
      commitSha: "basesha",
      measuredAt: { surface: "pull_request_preview", origin: "https://web-git-pr41.example.app" },
    });
    await store.record({
      ...key,
      commitSha: "mergesha",
      snapshot: carryMeasurementBaselineForward(head, { commitSha: "mergesha" }),
    });

    const read = await store.find({ ...key, commitSha: "mergesha" });
    expect(read?.carriedFrom).toBe("basesha");
    expect(read?.measuredAt).toEqual({
      surface: "pull_request_preview",
      origin: "https://web-git-pr41.example.app",
    });
  });
})
