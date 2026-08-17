import type { GateReviewResult, Measurement, MeasurementKind } from "@gate/types";
import {
  MEASUREMENT_IDENTITY_VERSION,
  measurementDefectKey,
  measurementElementKey,
  measurementFingerprint,
  normalizeRoute,
} from "./measurement-identity.js";
import { suppressMeasurements } from "./measurements.js";

/**
 * Scoping a measured violation to what THIS pull request introduced.
 *
 * Without this, every run reports every measurement on every page it captured.
 * As advisory output that is noise. As a merge gate it is unusable: the first
 * pull request after installation inherits the repository's entire back
 * catalogue of contrast failures, someone turns the tool off, and it reviews
 * nothing ever again. Every credible linter solves this with a baseline, and so
 * does this.
 *
 * THE SHAPE. Gate stores the measurement set it observed for a repository at a
 * commit. On a pull request it looks up the set stored for the BASE commit and
 * places each of this run's violations against it:
 *
 *   - in the baseline            -> pre-existing. Reported, marked, never gates.
 *   - not in the baseline        -> introduced. Gates, if the repository's mode
 *                                   and the engine's `blockEligible` both allow.
 *   - not comparable             -> unclassified. Reported as unclassified,
 *                                   never gates, and the reason is named.
 *
 * NO BASELINE IS THE CASE THAT DECIDES WHETHER ANY OF THIS IS TRUSTWORTHY. A
 * repository that has never had Gate run on its base branch has no stored set.
 * Reading that as "the base was clean" would hand that team precisely the back
 * catalogue this exists to prevent, on their very first pull request. So an
 * absent baseline classifies nothing, gates nothing, and SAYS SO: "no baseline,
 * so nothing here could be shown to be new" is a different sentence from "no new
 * violations", and the two must never render alike.
 *
 * PER ROUTE AND PER CHECK, NOT PER REPOSITORY. A baseline knows which routes it
 * measured and which checks it ran. A violation on a route the base run never
 * captured cannot be classified, and neither can one from a check the base run
 * never executed. Both are stated rather than guessed, because guessing here has
 * exactly one direction: it calls untouched defects new.
 *
 * THREE TIERS AND A BUDGET (added August 17, 2026). Matching on the selector,
 * however carefully the selector is normalized, still breaks on a markup
 * refactor: wrapping an element in a div, tightening a descendant combinator
 * into a child combinator, or renaming a class all move the whole path while the
 * contrast ratio underneath it does not move at all. Each of those read as one
 * violation resolved plus one introduced, which under `block` fails a pull
 * request that changed no colour, on exactly the mature repositories the
 * baseline was built for. So a violation that misses on both selector keys gets
 * a third and last chance against the `defectKey`: same check, same page, same
 * stated defect, no selector at all.
 *
 * That key is far too weak to be an identity, so it is spent rather than
 * matched. A defect-key hit may CLAIM one baseline entry, and only an entry that
 * is genuinely unaccounted for: an entry whose element is still present in this
 * run is already spoken for by that violation, and an entry another claim took
 * is gone. The number of same-defect violations on a route therefore cannot grow
 * without something being called introduced, which is the property that keeps
 * this from turning `block` off in the other direction.
 *
 * WHICH WAY AN AMBIGUOUS MATCH FALLS, and why. A claim can pick the wrong old
 * violation: a pull request that fixes one low-contrast element and adds another
 * with the same sentence on the same page reads as one resolved plus one carried
 * over, rather than one resolved plus one introduced. That is the cost, it is
 * paid knowingly, and it is the cheaper of the two. A false "already there" is a
 * violation Gate still renders, still counts, and still shows the reader; a
 * false "introduced" is a red check on somebody's unrelated pull request, and
 * the only escape from it is a suppression that also hides the real defect.
 *
 * WHO GETS THE CLAIM WHEN THERE ARE NOT ENOUGH (added August 17, 2026). Entries
 * sharing a defect key are interchangeable, so when more violations want one
 * than exist, the ones served last are called introduced. Serving them in the
 * engine's order let a violation MUTED by `rules.measurement_suppress` take the
 * entry an innocent refactored violation needed, and the muted one is invisible
 * while the innocent one turned the check red. A repository's only escape hatch
 * from a false red check was manufacturing one. Visible violations are therefore
 * served first, and a muted violation left without an entry is called introduced
 * where nothing renders it and nothing gates on it. Muted violations still spend
 * entries, because a mute hides a violation and does not fix it, and a spent
 * entry is one that cannot also be counted as resolved.
 *
 * AN ENGINE UPGRADE IS THE ONE TIME THE DETAIL LIES (added August 17, 2026). The
 * detail is the engine's own sentence, and the engine can reword it between two
 * runs while the page holds still. On its own that is absorbed: a reworded
 * violation on an unmoved element hits the `elementKey`. But a violation whose
 * markup ALSO moved misses the fingerprint, misses the elementKey, and misses
 * the defect key that the new wording no longer matches, so all three fail at
 * once and an untouched defect reads as introduced. That is the same false red
 * check the defect key was added to remove, reachable one engine release later.
 *
 * So the stored engine version is compared, not merely recorded. When it differs
 * from the engine that produced this run, a violation that missed every key may
 * spend an unaccounted-for entry recorded for the same page and check, and is
 * then reported as `engine_skew`: unclassified, never gating, and never called
 * pre-existing either, because nothing has shown it is the same violation. The
 * entry is spent, so two new violations cannot both shelter behind one that went
 * missing, and a violation on a page where nothing went missing gates as usual.
 * An unknown version on either side is not skew: Gate cannot show two engines
 * differ, and reading a missing field as skew would weaken every comparison on a
 * path that does not record it.
 *
 * WHAT THIS STILL MISSES, stated because the miss is silent and the alternative
 * is worse. Both are cases where a genuinely new violation is called
 * pre-existing, which Gate still reports and still shows the reader:
 *
 *   - The same element gaining a SECOND defect of the same check hits the
 *     `elementKey`, which is matched rather than spent. One stored entry can
 *     answer for both, so a button that was merely low-contrast and is now
 *     invisible reads as unchanged.
 *   - The defect key is magnitude-blind and threshold-blind, because the numbers
 *     are stripped from the detail. A normal-text contrast failure can therefore
 *     claim the entry of a deleted large-text one on the same page. The rule is
 *     not "the same sentence"; it is "the same sentence once every number is
 *     replaced".
 *
 * THE ROUTE IS NEVER FUZZY, AND A RENAMED PAGE IS THEREFORE UNCLASSIFIED. `/`
 * becoming `/home` is a markup refactor's cousin, and it is deliberately NOT
 * absorbed: the route is the last coordinate that keeps two pages apart, and a
 * defect key with a fuzzy route would let a genuinely new page inherit an old
 * page's clean bill of health without a word. So a violation on a renamed route
 * is `route_not_measured`: reported, named, never gated. The old route's entries
 * are not counted as resolved either, because this run never captured that page
 * and a page nobody looked at was not fixed. Both halves are the same rule, that
 * Gate does not guess across pages, and both are tested.
 */

/** One violation as it was recorded on a base commit. */
export interface MeasurementBaselineEntry {
  kind: MeasurementKind;
  /** Normalized route, kept in the clear so a resolved violation can be scoped to a page. */
  route: string;
  /** `measurementElementKey`: same check, same page, same element. */
  elementKey: string;
  /** `measurementFingerprint`: the full identity, detail included. */
  fingerprint: string;
  /**
   * `measurementDefectKey`: same check, same page, same stated defect, whatever
   * markup carries it. The only key that survives a wrapper, a combinator change
   * or a class rename, and the only one that is spent instead of matched.
   */
  defectKey: string;
}

/**
 * The measurement set observed for one repository at one commit.
 *
 * `checksRun` and `routesMeasured` are what make an EMPTY `entries` array mean
 * something. Empty entries with a non-empty `checksRun` is the positive claim
 * "these checks ran on these routes and found nothing", which makes a violation
 * on this pull request genuinely new. Empty entries with an empty `checksRun` is
 * "nothing was measured", which makes nothing classifiable at all. Collapsing
 * those two into "no violations recorded" is the mistake this type exists to
 * make impossible.
 */
export interface MeasurementBaselineSnapshot {
  /** `MEASUREMENT_IDENTITY_VERSION` the entries were computed under. */
  version: string;
  /** The commit this set was observed at. */
  commitSha: string;
  /** Deterministic checks the run demonstrably executed. */
  checksRun: MeasurementKind[];
  /** Normalized routes the run demonstrably measured. */
  routesMeasured: string[];
  entries: MeasurementBaselineEntry[];
  /** Engine version that produced it, for audit. Never part of the identity. */
  engineVersion?: string | null;
  /** Epoch ms the set was recorded. */
  recordedAtMs?: number;
}

/**
 * Checks a result proves were run.
 *
 * The union of what the engine SAID it ran and what its violations SHOW it ran:
 * a `contrast` violation is proof the contrast check executed, whatever
 * `checksRun` says. Only a lower bound is ever taken, never an upper one.
 */
export function measuredKinds(result: GateReviewResult): MeasurementKind[] {
  const report = result.measurements;
  if (report === undefined) return [];
  const kinds = new Set<MeasurementKind>(report.checksRun);
  for (const violation of report.violations) kinds.add(violation.kind);
  return [...kinds].sort();
}

/**
 * Routes a result proves were measured.
 *
 * Two sources, both evidence rather than inference. A violation on a route is
 * proof that route was captured and measured. A route in `coverage.routesReviewed`
 * is proof the route was captured, and measurements are computed from the
 * capture, so a captured route was measured by whichever checks ran.
 *
 * A result carrying no measurement report at all yields NOTHING here, however
 * full its coverage: "the model judged this page" is not "the deterministic
 * checks looked at it".
 */
export function measuredRoutes(result: GateReviewResult): string[] {
  const report = result.measurements;
  if (report === undefined) return [];
  const routes = new Set<string>();
  for (const route of result.coverage?.routesReviewed ?? []) routes.add(normalizeRoute(route));
  for (const violation of report.violations) routes.add(normalizeRoute(violation.route));
  return [...routes].sort();
}

export interface BuildBaselineOptions {
  /** The commit this result was produced for. */
  commitSha: string;
  recordedAtMs?: number;
}

/**
 * The storable measurement set for a completed review.
 *
 * Recorded from the UNSUPPRESSED violations on purpose. `rules.measurement_suppress`
 * is a rendering choice a repository can change between two runs, and a baseline
 * that moved when the config moved would report old violations as new the moment
 * a mute was lifted.
 */
export function buildMeasurementBaseline(
  result: GateReviewResult,
  options: BuildBaselineOptions,
): MeasurementBaselineSnapshot {
  const violations = result.measurements?.violations ?? [];
  return {
    version: MEASUREMENT_IDENTITY_VERSION,
    commitSha: options.commitSha,
    checksRun: measuredKinds(result),
    routesMeasured: measuredRoutes(result),
    entries: violations.map((violation) => ({
      kind: violation.kind,
      route: normalizeRoute(violation.route),
      elementKey: measurementElementKey(violation),
      fingerprint: measurementFingerprint(violation),
      defectKey: measurementDefectKey(violation),
    })),
    engineVersion: result.metadata.engineVersion ?? null,
    ...(options.recordedAtMs !== undefined ? { recordedAtMs: options.recordedAtMs } : {}),
  };
}

/** The repository + commit a baseline belongs to. */
export interface MeasurementBaselineKey {
  installationId: string;
  owner: string;
  name: string;
  commitSha: string;
}

export interface MeasurementBaselineRecord extends MeasurementBaselineKey {
  snapshot: MeasurementBaselineSnapshot;
}

/**
 * Durable per-repository, per-commit measurement sets.
 *
 * The interface lives beside the comparison rather than beside the SQL because
 * both delivery paths need it and only one of them has a database: the hosted
 * App path binds the Postgres implementation, and the Action path binds nothing
 * unless an operator gives it a store. A path with no store never gates, and
 * says which of the two reasons applies.
 */
export interface MeasurementBaselineStore {
  /** Persist the set for a commit. Idempotent on (repository, commit). */
  record(record: MeasurementBaselineRecord): Promise<void>;
  /** The stored set for a commit, or null when this commit has never been measured. */
  find(key: MeasurementBaselineKey): Promise<MeasurementBaselineSnapshot | null>;
}

function storeKey(key: MeasurementBaselineKey): string {
  return `${key.owner}/${key.name}@${key.commitSha}`;
}

/** In-memory store for local dev and tests; mirrors the SQL upsert's idempotency. */
export function createInMemoryMeasurementBaselineStore(): MeasurementBaselineStore & {
  snapshots: Map<string, MeasurementBaselineSnapshot>;
} {
  const snapshots = new Map<string, MeasurementBaselineSnapshot>();
  return {
    snapshots,
    async record(record) {
      snapshots.set(storeKey(record), record.snapshot);
    },
    async find(key) {
      return snapshots.get(storeKey(key)) ?? null;
    },
  };
}

/**
 * The answer to "what is stored for the base commit", including the answers that
 * are not a baseline.
 *
 * `absent` and `unavailable` are separated because the remedies differ and a
 * reader deserves to know which one they are looking at: `absent` means Gate
 * looked and this base commit has never been measured, which the next run on the
 * base branch fixes; `unavailable` means Gate could not look at all, which is an
 * operator's configuration or an outage.
 */
export type MeasurementBaselineLookup =
  | { status: "found"; snapshot: MeasurementBaselineSnapshot }
  | { status: "absent"; baseSha: string }
  | { status: "unavailable"; baseSha?: string; detail?: string };

/** Where a measured violation came from, relative to the base commit. */
export type MeasurementOrigin = "introduced" | "pre_existing" | "unclassified";

/** Why a violation could not be placed against the base. */
export type UnclassifiedReason =
  /** Nothing is stored for the base commit. */
  | "no_baseline"
  /** Gate could not read the baseline store. */
  | "baseline_unavailable"
  /** The stored set was computed under a different identity version. */
  | "version_skew"
  /** The base run never captured this route. */
  | "route_not_measured"
  /** The base run never executed this check. */
  | "check_not_run"
  /**
   * A different engine version recorded the baseline, and a violation recorded
   * on this route and check is unaccounted for in this run. A reworded violation
   * that also moved and a genuinely new one are indistinguishable there, so
   * neither reading is asserted.
   */
  | "engine_skew";

export interface ClassifiedMeasurement {
  measurement: Measurement;
  origin: MeasurementOrigin;
  reason?: UnclassifiedReason;
  /**
   * Same check, same page, same element on the base, and the engine's sentence
   * differs. Reported as pre-existing, never as introduced: an engine that
   * rewords its own output must not turn a back catalogue into a merge block.
   */
  detailChanged?: boolean;
  /**
   * Same check, same page, same stated defect on the base, carried by a
   * DIFFERENT selector, and it claimed a baseline entry nothing else accounted
   * for. A markup refactor around an untouched violation: a wrapper, a tightened
   * combinator, a renamed class. Reported as pre-existing, never as introduced,
   * and marked so a reader can see which of the two it is.
   */
  elementChanged?: boolean;
}

export type MeasurementBaselineStatus =
  /** A stored set was found for the base commit and used. */
  | "compared"
  /** Gate looked; this base commit has never been measured. */
  | "no_baseline"
  /** Gate could not look. */
  | "unavailable"
  /** The stored set predates the current identity version and cannot be compared. */
  | "version_skew";

export interface MeasurementComparison {
  status: MeasurementBaselineStatus;
  /** The commit the comparison was made against, when one was named. */
  baseSha?: string;
  /** Why the store could not be read, when it could not be. Gate-owned prose. */
  detail?: string;
  /** The identity version the stored set was computed under, on `version_skew`. */
  baselineVersion?: string;
  /**
   * Set when the stored set was recorded by a DIFFERENT engine version than the
   * one that produced this run, which is the only circumstance under which the
   * engine's own sentence may have changed without the page changing.
   *
   * Reported so the reader knows a weaker rule was in force, and so that a run
   * which withheld gating for this reason can be told apart from one that had
   * nothing to gate on.
   */
  engineSkew?: { baseline: string; current: string };
  /** How many violations the stored set holds. Zero under `compared` is a clean base. */
  baselineSize: number;
  /** Every visible violation with its origin, in the engine's order. */
  classified: ClassifiedMeasurement[];
  introduced: Measurement[];
  preExisting: Measurement[];
  unclassified: Measurement[];
  /**
   * Baseline violations that are gone: recorded on the base, on a route and
   * check THIS run also measured, and matched by nothing here. Scoped that way
   * so a route this run did not capture never masquerades as a fix.
   */
  resolved: number;
}

export interface CompareMeasurementsOptions {
  lookup: MeasurementBaselineLookup;
  /** `rules.measurement_suppress`, applied exactly as the renderer applies it. */
  suppress?: readonly string[];
}

const UNCOMPARABLE: Record<"absent" | "unavailable" | "skew", UnclassifiedReason> = {
  absent: "no_baseline",
  unavailable: "baseline_unavailable",
  skew: "version_skew",
};

function uncomparable(
  violations: readonly Measurement[],
  status: Exclude<MeasurementBaselineStatus, "compared">,
  reason: UnclassifiedReason,
  baseSha: string | undefined,
  baselineSize: number,
  extra: { detail?: string; baselineVersion?: string } = {},
): MeasurementComparison {
  const classified = violations.map((measurement) => ({
    measurement,
    origin: "unclassified" as const,
    reason,
  }));
  return {
    status,
    ...(baseSha !== undefined ? { baseSha } : {}),
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra.baselineVersion !== undefined ? { baselineVersion: extra.baselineVersion } : {}),
    baselineSize,
    classified,
    introduced: [],
    preExisting: [],
    unclassified: [...violations],
    resolved: 0,
  };
}

/**
 * Place this run's measured violations against the base commit's stored set.
 *
 * Nothing here can produce a false "introduced" from an absent, unreadable or
 * stale baseline: all three short-circuit into unclassified, which never gates.
 * The only way a violation is called introduced is that Gate has a comparable
 * stored set which measured that route with that check, and the violation is not
 * in it.
 */
export function compareMeasurementsToBaseline(
  result: GateReviewResult,
  options: CompareMeasurementsOptions,
): MeasurementComparison {
  const all = result.measurements?.violations ?? [];
  const visible = suppressMeasurements(all, options.suppress ?? []);
  const lookup = options.lookup;

  if (lookup.status === "absent") {
    return uncomparable(visible, "no_baseline", UNCOMPARABLE.absent, lookup.baseSha, 0);
  }
  if (lookup.status === "unavailable") {
    return uncomparable(visible, "unavailable", UNCOMPARABLE.unavailable, lookup.baseSha, 0, {
      ...(lookup.detail !== undefined ? { detail: lookup.detail } : {}),
    });
  }
  const snapshot = lookup.snapshot;
  if (snapshot.version !== MEASUREMENT_IDENTITY_VERSION) {
    return uncomparable(
      visible,
      "version_skew",
      UNCOMPARABLE.skew,
      snapshot.commitSha,
      snapshot.entries.length,
      { baselineVersion: snapshot.version },
    );
  }

  const fingerprints = new Set(snapshot.entries.map((entry) => entry.fingerprint));
  const elementKeys = new Set(snapshot.entries.map((entry) => entry.elementKey));
  const baseRoutes = new Set(snapshot.routesMeasured);
  const baseChecks = new Set(snapshot.checksRun);

  // Which stored violations are genuinely unaccounted for, and therefore the
  // only ones a markup refactor may claim. An entry whose element is still
  // present in this run is spoken for by that violation, however its detail
  // reads, so it can never also be handed to a second one. That is the single
  // rule standing between "a refactor carries its violation over" and "a new
  // violation hides behind an old one".
  //
  // Built from EVERY violation this run reported, not just the visible ones: a
  // repository that muted a violation with `rules.measurement_suppress` still
  // has it on the page, and the entry it accounts for is not free.
  const presentKeys = new Set(all.map(measurementElementKey));
  const claimable = new Map<string, number[]>();
  // The same unaccounted-for entries, indexed only by the page and the check.
  // Consulted under engine skew and never otherwise: it is weaker than the
  // defect key, which is already the weakest key Gate is willing to match on.
  const claimableHere = new Map<string, number[]>();
  const routeKind = (kind: MeasurementKind, route: string): string => `${kind} ${route}`;
  snapshot.entries.forEach((entry, index) => {
    if (presentKeys.has(entry.elementKey)) return;
    const waiting = claimable.get(entry.defectKey);
    if (waiting) waiting.push(index);
    else claimable.set(entry.defectKey, [index]);
    const here = routeKind(entry.kind, entry.route);
    const waitingHere = claimableHere.get(here);
    if (waitingHere) waitingHere.push(index);
    else claimableHere.set(here, [index]);
  });
  const claimedEntries = new Set<number>();

  /**
   * Spend one unaccounted-for entry from an index, or report there is none.
   *
   * Both indices point into the same entries, so a pop has to walk past
   * anything the other index already spent. An entry is claimable exactly once,
   * whichever door it is reached through.
   */
  const spend = (index: Map<string, number[]>, key: string): boolean => {
    const waiting = index.get(key);
    while (waiting && waiting.length > 0) {
      const entry = waiting.pop();
      if (entry === undefined) break;
      if (claimedEntries.has(entry)) continue;
      claimedEntries.add(entry);
      return true;
    }
    return false;
  };

  // A baseline recorded by one engine and a run produced by another are the only
  // pair where the engine's own sentence can move without the page moving. When
  // it does move on a violation whose selector ALSO moved, every key here misses
  // at once and an untouched defect reads as introduced, which is the false red
  // check this whole module exists to prevent.
  //
  // An unknown version on either side is NOT skew. Gate cannot show the two
  // engines differ, and inventing skew from a missing field would weaken every
  // comparison on a path that does not record it.
  const currentEngine = result.metadata.engineVersion;
  const baselineEngine = snapshot.engineVersion;
  const engineSkew =
    typeof baselineEngine === "string" &&
    baselineEngine.length > 0 &&
    typeof currentEngine === "string" &&
    currentEngine.length > 0 &&
    baselineEngine !== currentEngine
      ? { baseline: baselineEngine, current: currentEngine }
      : undefined;

  const place = (measurement: Measurement): ClassifiedMeasurement => {
    if (!baseRoutes.has(normalizeRoute(measurement.route))) {
      // A renamed route lands here on purpose: see THE ROUTE IS NEVER FUZZY.
      return { measurement, origin: "unclassified" as const, reason: "route_not_measured" as const };
    }
    if (!baseChecks.has(measurement.kind)) {
      return { measurement, origin: "unclassified" as const, reason: "check_not_run" as const };
    }
    if (fingerprints.has(measurementFingerprint(measurement))) {
      return { measurement, origin: "pre_existing" as const };
    }
    if (elementKeys.has(measurementElementKey(measurement))) {
      return { measurement, origin: "pre_existing" as const, detailChanged: true };
    }
    if (spend(claimable, measurementDefectKey(measurement))) {
      return { measurement, origin: "pre_existing" as const, elementChanged: true };
    }
    // Under skew, and only under skew, a violation that missed every key may
    // still be an old one the engine reworded while the markup moved. It is not
    // called pre-existing, because nothing here shows it is the same violation;
    // it is called unclassified, which reports it and gates on nothing. The
    // entry is spent all the same, so two new violations cannot both shelter
    // behind one that vanished, and a violation on a page where nothing went
    // missing still gates normally.
    if (engineSkew && spend(claimableHere, routeKind(measurement.kind, normalizeRoute(measurement.route)))) {
      return { measurement, origin: "unclassified" as const, reason: "engine_skew" as const };
    }
    return { measurement, origin: "introduced" as const };
  };

  // Placed over EVERY violation and rendered for the visible ones, because a
  // claim spends a shared resource: a muted violation still sitting on an old
  // element must take its own entry with it, or a mute would read as a fix.
  //
  // VISIBLE VIOLATIONS CLAIM FIRST, and the order is the whole point. Entries
  // sharing a defect key are interchangeable, so when there are fewer of them
  // than claimants, whoever is served last is called introduced. Serving the
  // engine's order instead would let a MUTED violation take the entry an
  // innocent refactored one needed, and `rules.measurement_suppress` would then
  // manufacture the red check it is the escape hatch from. A muted violation
  // left with no entry is called introduced too, and is rendered by nothing and
  // gates on nothing, which is what a repository asked for when it muted it.
  const shown = new Set(visible);
  const rows: (ClassifiedMeasurement | undefined)[] = new Array(all.length);
  all.forEach((measurement, index) => {
    if (shown.has(measurement)) rows[index] = place(measurement);
  });
  all.forEach((measurement, index) => {
    if (!shown.has(measurement)) rows[index] = place(measurement);
  });
  const classified = rows.filter(
    (row): row is ClassifiedMeasurement => row !== undefined && shown.has(row.measurement),
  );

  // A fix is measured against EVERY violation this run reported, not just the
  // visible ones: muting a violation with `rules.measurement_suppress` hides it,
  // it does not fix it, and counting a mute as a fix would be the one lie this
  // surface can tell in the flattering direction. An entry a refactored
  // violation claimed is not a fix either: the defect moved, it did not go.
  const nowRoutes = new Set(measuredRoutes(result));
  const nowChecks = new Set(measuredKinds(result));
  const resolved = snapshot.entries.filter(
    (entry, index) =>
      nowRoutes.has(entry.route) &&
      nowChecks.has(entry.kind) &&
      !presentKeys.has(entry.elementKey) &&
      !claimedEntries.has(index),
  ).length;

  return {
    status: "compared",
    baseSha: snapshot.commitSha,
    ...(engineSkew ? { engineSkew } : {}),
    baselineSize: snapshot.entries.length,
    classified,
    introduced: classified.filter((row) => row.origin === "introduced").map((row) => row.measurement),
    preExisting: classified.filter((row) => row.origin === "pre_existing").map((row) => row.measurement),
    unclassified: classified.filter((row) => row.origin === "unclassified").map((row) => row.measurement),
    resolved,
  };
}

/**
 * The violations a repository's `rules.measurements: block` may fail a check on.
 *
 * Introduced AND engine-marked block-eligible. Both conditions, always: the
 * engine decides what is precise enough to gate on, the baseline decides what
 * this pull request is answerable for, and neither one alone is enough.
 */
export function gateableMeasurements(comparison: MeasurementComparison): Measurement[] {
  return comparison.introduced.filter((violation) => violation.blockEligible);
}

/**
 * Read the stored set for a base commit without ever letting the store's failure
 * reach the pull request.
 *
 * A baseline lookup is not on the critical path of publishing a review, and a
 * database that is down must degrade into "cannot classify, therefore cannot
 * gate" rather than into a missing Check Run.
 */
export async function lookupMeasurementBaseline(
  store: MeasurementBaselineStore | undefined,
  key: MeasurementBaselineKey,
): Promise<MeasurementBaselineLookup> {
  if (!store) {
    return {
      status: "unavailable",
      baseSha: key.commitSha,
      detail: "no baseline store is configured for this path",
    };
  }
  try {
    const snapshot = await store.find(key);
    return snapshot ? { status: "found", snapshot } : { status: "absent", baseSha: key.commitSha };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[gate] measurement baseline lookup failed: ${detail}`);
    return { status: "unavailable", baseSha: key.commitSha, detail: "the baseline store could not be read" };
  }
}
