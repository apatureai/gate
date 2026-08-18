import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import {
  buildMeasurementBaseline,
  compareMeasurementsToBaseline,
  gateableMeasurements,
  lookupMeasurementBaseline,
} from "@gate/delivery";
import { loadGoldenReviewResult, type GateReviewResult, type Measurement } from "@gate/types";
import { beforeEach, describe, expect, it } from "vitest";
import { createSqlMeasurementBaselineStore } from "../src/measurement-baseline-store.js";

/**
 * The severity band has to survive Postgres, and an ABSENT one has to survive as
 * absent.
 *
 * Entries are stored as `jsonb`, so the band needed no migration and no identity
 * bump: it is a new key inside a value the column already held. What it does
 * need is a reader that tells "no band was recorded" apart from "band zero",
 * because a row written before this field existed carries the SAME identity
 * version and is compared normally. If that absence came back as a number, every
 * banded violation on every baseline already in the field would read as a
 * regression the next pull request caused.
 */

let db: PGlite;
const query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  db.query<T>(sql, params as unknown[]);
const newStore = () => createSqlMeasurementBaselineStore(query);

const key = { installationId: "1", owner: "acme", name: "web", commitSha: "basesha" };

const violation = (over: Partial<Measurement> = {}): Measurement => ({
  kind: "contrast",
  route: "/pricing",
  viewports: ["mobile"],
  element: "#hero-subtitle",
  detail: "text contrast 2.91:1 is below WCAG AA 4.5:1",
  blockEligible: true,
  severity: 2,
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

/** The same defect measured worse: same fingerprint, higher band. */
const worse = violation({ detail: "text contrast 1.02:1 is below WCAG AA 4.5:1", severity: 3 });

const storedFor = (violations: Measurement[]) =>
  buildMeasurementBaseline(resultWith(violations), { commitSha: "basesha" });

beforeEach(async () => {
  db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  await db.exec("INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10)");
});

describe("the severity band round-trips through jsonb", () => {
  it("comes back on the entry it was stored on", async () => {
    const store = newStore();
    await store.record({ ...key, snapshot: storedFor([violation()]) });

    const lookup = await lookupMeasurementBaseline(store, key);
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") return;
    expect(lookup.snapshot.entries[0]?.severity).toBe(2);
  });

  it("survives the round trip well enough to fail a check on a real regression", async () => {
    const store = newStore();
    await store.record({ ...key, snapshot: storedFor([violation()]) });
    const lookup = await lookupMeasurementBaseline(store, key);

    const comparison = compareMeasurementsToBaseline(resultWith([worse]), { lookup });
    expect(comparison.worsened).toEqual([worse]);
    expect(gateableMeasurements(comparison)).toEqual([worse]);
  });

  it("brings a row stored before the field existed back as UNKNOWN, never as zero", async () => {
    // Written exactly as an older build left it: the same identity version, the
    // same keys, and no band. Nothing about it is skewed, so it is compared.
    const snapshot = storedFor([violation()]);
    const legacy = snapshot.entries.map(({ severity: _drop, ...entry }) => entry);
    const store = newStore();
    await store.record({ ...key, snapshot: { ...snapshot, entries: legacy } });

    const lookup = await lookupMeasurementBaseline(store, key);
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") return;
    expect(lookup.snapshot.entries[0]).not.toHaveProperty("severity");

    // ...and therefore nothing gates, however much worse this run measured.
    const comparison = compareMeasurementsToBaseline(resultWith([worse]), { lookup });
    expect(comparison.preExisting).toEqual([worse]);
    expect(comparison.worsened).toEqual([]);
    expect(gateableMeasurements(comparison)).toEqual([]);
  });

  it("drops a stored band that is not a band rather than comparing against it", async () => {
    // A row Gate did not write in this process. `0` is the dangerous one: read
    // as a band it is the bottom of the scale, so every violation above it would
    // report as a regression on a repository that changed nothing.
    const snapshot = storedFor([violation()]);
    for (const bad of [0, -1, 2.91, "3", null]) {
      const entries = snapshot.entries.map((entry) => ({ ...entry, severity: bad }));
      const store = newStore();
      await store.record({
        ...key,
        snapshot: { ...snapshot, entries: entries as unknown as typeof snapshot.entries },
      });

      const lookup = await lookupMeasurementBaseline(store, key);
      expect(lookup.status).toBe("found");
      if (lookup.status !== "found") continue;
      expect(lookup.snapshot.entries[0]).not.toHaveProperty("severity");
      expect(compareMeasurementsToBaseline(resultWith([worse]), { lookup }).worsened).toEqual([]);
    }
  });
});

describe("the viewports on a stored row survive jsonb the same way the band does", () => {
  /**
   * These decide which stored rows a band is compared against and which
   * violations the unseen-viewport screen excuses, so a value read back wrong is
   * a wrong verdict rather than a cosmetic loss. Every rule here is stated in
   * the reader's own comments and none of them was asserted.
   */
  it("writes NULL rather than an empty list when the snapshot does not know", async () => {
    const store = newStore();
    const snapshot = storedFor([violation()]);
    const { viewportsMeasured: _unknown, ...older } = snapshot;
    await store.record({ ...key, snapshot: older });

    const { rows } = await query<{ viewports_measured: unknown }>(
      "SELECT viewports_measured FROM measurement_baselines",
    );
    // An empty list is a positive claim that this run measured no viewports at
    // all, and it screens every new violation out of gating. Absent is the only
    // honest value for "this snapshot does not carry the field".
    expect(rows[0]?.viewports_measured).toBeNull();
  });

  it("brings a NULL column back as absent rather than as an empty list", async () => {
    const store = newStore();
    const snapshot = storedFor([violation()]);
    const { viewportsMeasured: _unknown, ...older } = snapshot;
    await store.record({ ...key, snapshot: older });

    const lookup = await lookupMeasurementBaseline(store, key);
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") return;
    expect(lookup.snapshot).not.toHaveProperty("viewportsMeasured");
  });

  it("round-trips a row's own viewport list", async () => {
    const store = newStore();
    await store.record({ ...key, snapshot: storedFor([violation()]) });

    const lookup = await lookupMeasurementBaseline(store, key);
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") return;
    expect(lookup.snapshot.entries[0]?.viewports).toEqual(["mobile"]);
  });

  it("refuses a half-read viewport list instead of coercing it", async () => {
    // A list with a non-string in it is not a viewport list, and silently
    // keeping the readable half would quietly change which stored rows a band is
    // compared against. Same rule the band already follows for a `"3"`.
    const store = newStore();
    const snapshot = storedFor([violation()]);
    const damaged = {
      ...snapshot,
      entries: snapshot.entries.map((entry) => ({ ...entry, viewports: ["mobile", 7] })),
    };
    await store.record({ ...key, snapshot: damaged as typeof snapshot });

    const lookup = await lookupMeasurementBaseline(store, key);
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") return;
    expect(lookup.snapshot.entries[0]).not.toHaveProperty("viewports");
  });

  it("keeps a legitimately empty list as an empty list", async () => {
    // Empty and absent are different claims and the reader must not fold one
    // into the other: empty says this row was measured nowhere, absent says
    // nobody recorded where it was measured.
    const store = newStore();
    const snapshot = storedFor([violation()]);
    const nowhere = {
      ...snapshot,
      entries: snapshot.entries.map((entry) => ({ ...entry, viewports: [] })),
    };
    await store.record({ ...key, snapshot: nowhere });

    const lookup = await lookupMeasurementBaseline(store, key);
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") return;
    expect(lookup.snapshot.entries[0]?.viewports).toEqual([]);
  });
});
