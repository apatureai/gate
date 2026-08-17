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
