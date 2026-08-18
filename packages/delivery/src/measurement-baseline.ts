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
 * ONE STORED VIOLATION ANSWERS FOR ONE VIOLATION HERE (added August 17, 2026).
 * Every tier draws from a single budget of entries, and the tiers run one after
 * another over everything still unplaced rather than one violation at a time
 * through all four. Both halves matter. A tier that MATCHED instead of spending
 * would let one entry absolve every violation on its element, so an element that
 * already had a defect could take on a second one and still read as unchanged.
 * Placing violations one at a time would let a violation reach a weak key and
 * spend the entry that a later violation matches exactly, so the strength of a
 * match would depend on the engine's ordering rather than on the evidence.
 *
 * The one exception is the element key under engine skew, which is matched and
 * not spent, because a new engine may report as two rows what the old one
 * reported as one and budgeting that would call the second row new on a page
 * nobody edited. Under a single engine a second row is a second defect, since
 * the wording cannot have moved on its own. An entry matched that way is still
 * recorded as answered, so a violation just called pre-existing is never also
 * counted among the ones that are gone.
 *
 * WHAT THIS STILL MISSES, stated because the miss is silent and the alternative
 * is worse. Every key here is magnitude-blind and threshold-blind, because the
 * numbers are stripped from the detail before hashing. "Contrast 2.91:1" and
 * "contrast 1.02:1" on one element are therefore one violation whose measurement
 * moved, not two, and a normal-text contrast failure can claim the entry of a
 * deleted large-text one on the same page. The rule is not "the same sentence";
 * it is "the same sentence once every number in it is replaced". Keeping the
 * numbers would put every re-measured ratio on the gate, which is the failure
 * this whole module exists to prevent, so the blindness is chosen and the miss
 * lands on the side that reports rather than the side that blocks.
 *
 * A VIOLATION THAT WAS ALREADY HERE CAN STILL BE MADE WORSE (added August 17,
 * 2026), and until now that was invisible. The paragraph above is exactly right
 * about why the numbers are stripped, and exactly wrong about what to do next: a
 * pull request that takes an element from 2.91:1 to 1.02:1 matched the stored
 * entry, reported as pre-existing, and reported as UNCHANGED. A real regression
 * on markup that already had a defect passed a `block` gate in silence.
 *
 * Gate cannot close that on its own, and the shape of the fix follows from why.
 * Gate stores hashes: selectors and engine sentences derive from the customer's
 * page and are deliberately never kept, so there are no numbers here to compare.
 * And Gate cannot tell from prose which DIRECTION is worse, since lower is worse
 * for contrast, larger for overflow and smaller for a touch target; deriving
 * that from the engine's wording would be Gate computing a judgment the engine
 * owns. So the engine states an ordinal `severity` BAND per violation, Gate
 * stores it beside the keys, and Gate compares bands and nothing else. The bands
 * are coarse enough that re-measurement noise cannot move one, which is what
 * makes a band change a material change by construction. Raw magnitudes still
 * never cross this boundary.
 *
 * A pre-existing violation whose current band is HIGHER than the band stored for
 * the entry it claimed is WORSENED. It is not introduced, and calling it that
 * would be a lie a reader would act on: this violation was already here, and
 * this pull request made it materially worse. Those are different sentences, and
 * every surface keeps them apart. Under `block` a worsened violation fails the
 * check on the same terms an introduced one does, and one more: BOTH BANDS MUST
 * BE KNOWN. An older engine, an entry stored before the field existed, or a
 * check that computes no band leaves an unknown on one side, and an unknown
 * never gates, exactly as an absent `blockEligible` never gates.
 *
 * Identity is untouched by any of this. A band is a fact ABOUT a violation, not
 * part of what makes two violations the same one, so it is not in any key and
 * `MEASUREMENT_IDENTITY_VERSION` does not move. A bump would invalidate every
 * baseline stored in the field to add a column nothing matches on.
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
  /**
   * Viewports this violation was measured at, sorted. Optional: rows stored
   * before the field existed do not carry it, and absent means unknown.
   *
   * NOT part of any key, and it must never become one. Identity excludes the
   * viewport on purpose, so this never decides whether two violations are the
   * same violation. It decides which stored rows a BAND may be compared
   * against, which is a different question with a different answer: an element
   * behind a media query is one identity measured at two viewports, and its two
   * bands are two facts about two renderings rather than one fact about the
   * element. Comparing a desktop band against the worst of both hid a desktop
   * regression from 3.40:1 to 1.02:1 behind a mobile row that was already worse.
   */
  viewports?: string[];
  /**
   * The ENGINE's ordinal severity band as it stood on the base commit. Higher is
   * worse, comparable only within a `kind`.
   *
   * NOT part of any key and not part of the identity: it is a fact about the
   * violation, not what makes two violations the same one, which is why adding
   * it does not move `MEASUREMENT_IDENTITY_VERSION`.
   *
   * Optional because an entry stored before this field existed has no band, and
   * because an engine may not compute one. That absence must read as UNKNOWN and
   * never as zero: zero is the bottom of the scale, so treating it as a number
   * would make every band above it look like a regression this pull request
   * caused, on a repository that has changed nothing.
   */
  severity?: number;
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
  /**
   * Viewports the run demonstrably measured. Optional because baselines stored
   * before severity bands existed do not carry it, and absent means unknown
   * rather than none.
   *
   * Only the BAND comparison reads this. Identity deliberately excludes the
   * viewport, so a violation that used to show at mobile and now also shows at
   * desktop is the same violation. Its worst band across viewports is not the
   * same number, though, so a repository that widened its `viewports:` config
   * can raise the worst band on a page whose markup nobody touched.
   */
  viewportsMeasured?: string[];
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

/**
 * Viewports a result proves were measured.
 *
 * Same two sources as `measuredRoutes` and the same rule: evidence, never
 * inference. A violation reported at a viewport is proof that viewport was
 * measured, and a viewport in `coverage.viewportsReviewed` is proof the capture
 * ran there.
 */
export function measuredViewports(result: GateReviewResult): string[] {
  const report = result.measurements;
  if (report === undefined) return [];
  const viewports = new Set<string>();
  for (const viewport of result.coverage?.viewportsReviewed ?? []) viewports.add(viewport);
  for (const violation of report.violations) {
    for (const viewport of violation.viewports) viewports.add(viewport);
  }
  return [...viewports].sort();
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
    viewportsMeasured: measuredViewports(result),
    entries: violations.map((violation) => ({
      kind: violation.kind,
      route: normalizeRoute(violation.route),
      elementKey: measurementElementKey(violation),
      fingerprint: measurementFingerprint(violation),
      defectKey: measurementDefectKey(violation),
      // Recorded only when the engine stated one. The key is left off entirely
      // rather than written as `undefined` or `0`, so a snapshot round-tripped
      // through jsonb says "this engine did not state a band" rather than
      // "this engine stated the best band there is".
      ...(violation.severity !== undefined ? { severity: violation.severity } : {}),
      viewports: [...violation.viewports].sort(),
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
   * The base run never measured the viewport this violation was found at, so
   * nothing stored can say whether it was already there.
   */
  | "viewport_not_measured"
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
  /**
   * This violation was already on the base and this pull request moved it into a
   * WORSE severity band.
   *
   * Its own claim, not a synonym for either of its neighbours. "Introduced"
   * would be false, because the violation was already here; "pre-existing, and
   * that is all" would be false too, because the page really did get worse and a
   * `block` repository asked to hear about exactly that. Set only when both
   * bands are known and the current one is STRICTLY higher, so an unknown on
   * either side leaves the row an ordinary carry-over and an unmoved band is not
   * a regression.
   *
   * `origin` stays `pre_existing`: this changes what a violation DID, not where
   * it came from, and a row counted as introduced on one surface and
   * pre-existing on another is how two published surfaces start disagreeing.
   */
  worsened?: boolean;
  /** The band recorded for the entry this violation claimed, when one is known. */
  baselineSeverity?: number;
  /** The band the engine states for this violation now, when it states one. */
  currentSeverity?: number;
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
  /**
   * Pre-existing violations this pull request moved into a worse severity band.
   *
   * A SUBSET of `preExisting`, deliberately, and never a member of `introduced`:
   * every one of these was already on the base, and the count that says how many
   * violations this pull request added must not quietly grow by them. Under
   * `block` they gate on the same terms an introduced violation does, which is
   * the whole point of separating them out rather than leaving them silent.
   */
  worsened: Measurement[];
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
    // Nothing was placed against the base, so nothing can be shown to have got
    // worse either. An uncomparable baseline gates on exactly as little as it
    // did before bands existed.
    worsened: [],
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

  const elementKeys = new Set(snapshot.entries.map((entry) => entry.elementKey));
  const baseRoutes = new Set(snapshot.routesMeasured);
  const baseChecks = new Set(snapshot.checksRun);

  // ONE STORED VIOLATION ANSWERS FOR ONE VIOLATION HERE, whichever key reached
  // it. Every tier draws from the same budget of entries, so the number of
  // violations on a page cannot grow while every one of them reports as already
  // there. A key that were merely MATCHED rather than spent would let one entry
  // absolve two: an element that used to be low-contrast and now carries a
  // second, worse failure would read as unchanged, and `block` would never see
  // a regression on markup that already had a defect of the same check.
  //
  // Every index is built over EVERY violation this run reported, not just the
  // visible ones: a repository that muted a violation with
  // `rules.measurement_suppress` still has it on the page, and the entry it
  // accounts for is not free.
  const routeKind = (kind: MeasurementKind, route: string): string => `${kind} ${route}`;
  const indexEntries = (key: (entry: MeasurementBaselineEntry) => string): Map<string, number[]> => {
    const index = new Map<string, number[]>();
    snapshot.entries.forEach((entry, position) => {
      const waiting = index.get(key(entry));
      if (waiting) waiting.push(position);
      else index.set(key(entry), [position]);
    });
    return index;
  };
  const byFingerprint = indexEntries((entry) => entry.fingerprint);
  const byElementKey = indexEntries((entry) => entry.elementKey);
  const byDefectKey = indexEntries((entry) => entry.defectKey);
  // The same entries indexed only by the page and the check. Consulted under
  // engine skew and never otherwise: it is weaker than the defect key, which is
  // already the weakest key Gate is willing to match on.
  const byRouteKind = indexEntries((entry) => routeKind(entry.kind, entry.route));
  const claimedEntries = new Set<number>();
  /** Element keys matched under engine skew without spending an entry. */
  const answeredLeniently = new Set<string>();

  /**
   * Spend one unclaimed entry from an index, or report there is none.
   *
   * Every index points into the same entries, so a take has to walk past
   * anything another index already spent. An entry is claimable exactly once,
   * whichever door it is reached through.
   *
   * Served oldest first, which pairs the two runs the way a reader would: first
   * with first. NOTHING OBSERVABLE DEPENDS ON THAT, and the reason is worth
   * knowing, because it did once. Entries under one key are interchangeable for
   * classification, so which one a violation claims changes no output; taking
   * them from the back is indistinguishable from taking them from the front. The
   * band comparison was briefly the exception, when it read the severity off the
   * individual entry a violation claimed. Entries in reverse then paired one
   * page's two viewports against each other, so a page compared against ITSELF
   * reported one violation improved and one made worse and an empty pull request
   * failed its check. That is fixed where it belonged, in `worstRecorded`, which
   * asks the whole group instead of one arbitrary member. This order is kept
   * because it is the one a reader would guess, not because anything rests on
   * it.
   *
   * Returns the POSITION of the entry it spent rather than a bare `true` so a
   * caller can tell "claimed nothing" from "claimed entry zero". Position `0` is
   * a real answer, so every caller tests `!== undefined` and never truthiness.
   */
  const spend = (index: Map<string, number[]>, key: string): number | undefined => {
    const waiting = index.get(key);
    while (waiting && waiting.length > 0) {
      const entry = waiting.shift();
      if (entry === undefined) break;
      if (claimedEntries.has(entry)) continue;
      claimedEntries.add(entry);
      return entry;
    }
    return undefined;
  };

  /**
   * A carried-over violation, with the band comparison attached.
   *
   * `stored` is the worst band recorded under the key that matched this
   * violation, or `undefined` when there is none to read. UNKNOWN ON EITHER SIDE IS NOT A
   * COMPARISON: no band reaches the row, `worsened` is not set, and the
   * violation stays an ordinary pre-existing one that gates on nothing. That is
   * the rule an absent `blockEligible` already follows, and it is what keeps an
   * older engine, a baseline stored before the field existed, and a check that
   * computes no band from authorizing a merge block. Reading an absent band as
   * `0` would do the opposite of all three: zero is the bottom of the scale, so
   * every banded violation on an old baseline would read as a regression this
   * pull request caused.
   *
   * The test is STRICTLY greater, never `>=`. A band that did not move is a
   * violation that did not get worse, and `>=` would turn every unchanged
   * carry-over on the page into a red check.
   */
  /**
   * Whether a band recorded on the base is comparable to a band measured now.
   *
   * A band is the WORST measurement across the viewports a run looked at, and
   * identity excludes the viewport on purpose. So a repository that widened its
   * `viewports:` config measures the same markup at a viewport the base run
   * never visited, the worst band rises, and byte-identical HTML reads as a
   * regression this pull request caused. That is a false red check produced by a
   * config edit, which is exactly the shape this module exists to prevent.
   *
   * The rule is therefore a subset test, not an equality test: every viewport
   * measured now must be one the base run measured too. Measuring FEWER is fine,
   * since a band that fell because nobody looked cannot be a worsening. A
   * baseline stored before this field existed says nothing about its viewports,
   * and unknown never gates.
   */
  const bandsComparable = ((): boolean => {
    const recorded = snapshot.viewportsMeasured;
    if (recorded === undefined) return false;
    const base = new Set(recorded);
    return measuredViewports(result).every((viewport) => base.has(viewport));
  })();

  const carried = (
    measurement: Measurement,
    stored: number | undefined,
    extra: Omit<ClassifiedMeasurement, "measurement" | "origin"> = {},
  ): ClassifiedMeasurement => {
    const row: ClassifiedMeasurement = { measurement, origin: "pre_existing", ...extra };
    const current = measurement.severity;
    if (!bandsComparable || stored === undefined || current === undefined) return row;
    row.baselineSeverity = stored;
    row.currentSeverity = current;
    if (current > stored) row.worsened = true;
    return row;
  };

  /**
   * The band a carried-over violation is compared against: the WORST band
   * recorded under the key that matched it.
   *
   * NOT the band on the individual entry the violation claimed, and the
   * difference is the whole correctness of this comparison. Several stored
   * violations can share one identity, because identity deliberately excludes
   * the viewport: one element measured at mobile and at desktop is one identity
   * and two entries, and a colour token behind a media query gives them
   * different bands. Reading the claimed entry made the answer depend on which
   * of those two a violation happened to be paired with, so a page compared
   * against ITSELF reported one violation improved and one made worse, and an
   * empty pull request failed its check.
   *
   * Asking instead whether ANY violation of this identity was already this bad
   * is order-independent, and it leans away from calling something worsened.
   * The cost is on the record: when one of two viewports regresses to a band the
   * other viewport already had, that regression is reported and never gated. A
   * missed "worse" is a violation Gate still renders; a false "worse" is a red
   * check on work that did not cause it, which is the error this module spends
   * everything else avoiding.
   *
   * One entry without a band makes the whole answer unknown, for the same
   * reason: an entry that might have been worse cannot be ruled out.
   */
  const worstRecorded = (
    measurement: Measurement,
    matches: (entry: MeasurementBaselineEntry) => boolean,
  ): number | undefined => {
    const here = new Set<string>(measurement.viewports);
    const candidates = snapshot.entries.filter(matches);
    // A row stored before viewports were recorded cannot be placed at a
    // viewport, so the whole identity is taken as one group, which is what this
    // did before entries carried viewports at all.
    const placed = candidates.every((entry) => entry.viewports !== undefined);
    const comparable = placed
      ? candidates.filter((entry) => entry.viewports?.some((viewport) => here.has(viewport)))
      : candidates;
    // No stored row was measured where this one was. That is not "it was fine
    // before", it is "nobody looked before", and the two must never render or
    // gate alike.
    if (comparable.length === 0) return undefined;
    let worst: number | undefined;
    for (const entry of comparable) {
      if (entry.severity === undefined) return undefined;
      if (worst === undefined || entry.severity > worst) worst = entry.severity;
    }
    return worst;
  };
  const worstForElement = (measurement: Measurement, key: string): number | undefined =>
    worstRecorded(measurement, (entry) => entry.elementKey === key);
  const worstForDefect = (measurement: Measurement, key: string): number | undefined =>
    worstRecorded(measurement, (entry) => entry.defectKey === key);

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

  const shown = new Set(visible);

  // MATCHED IN TIERS, STRONGEST KEY FIRST, and every tier finished before the
  // next begins. Placing one violation at a time through all four tiers would
  // let a violation reach a weak key and spend the entry that a later violation
  // would have matched exactly, so the strength of a match would depend on the
  // engine's ordering rather than on the evidence.
  //
  // Within a tier, VISIBLE VIOLATIONS ARE SERVED FIRST. Entries sharing a key
  // are interchangeable, so when there are fewer of them than claimants,
  // whoever is served last is called introduced. Serving the engine's order let
  // a MUTED violation take the entry an innocent refactored one needed, and
  // `rules.measurement_suppress` would then manufacture the red check it is the
  // escape hatch from. A muted violation left with no entry is called
  // introduced too, and is rendered by nothing and gates on nothing, which is
  // what a repository asked for when it muted it.
  const rows: (ClassifiedMeasurement | undefined)[] = new Array(all.length);
  const order = [
    ...all.map((_, index) => index).filter((index) => shown.has(all[index]!)),
    ...all.map((_, index) => index).filter((index) => !shown.has(all[index]!)),
  ];

  /** Run one tier over what is still unplaced, and hand back the rest. */
  const tier = (
    pending: readonly number[],
    place: (measurement: Measurement) => ClassifiedMeasurement | null,
  ): number[] => {
    const rest: number[] = [];
    for (const index of pending) {
      const row = place(all[index]!);
      if (row) rows[index] = row;
      else rest.push(index);
    }
    return rest;
  };

  // Screening first: a route or a check the base run never covered is not a
  // comparison Gate can make at all, and a renamed route lands here on purpose.
  // See THE ROUTE IS NEVER FUZZY.
  const comparable = tier(order, (measurement) => {
    if (!baseRoutes.has(normalizeRoute(measurement.route))) {
      return { measurement, origin: "unclassified" as const, reason: "route_not_measured" as const };
    }
    if (!baseChecks.has(measurement.kind)) {
      return { measurement, origin: "unclassified" as const, reason: "check_not_run" as const };
    }
    return null;
  });

  const afterExact = tier(comparable, (measurement) => {
    const entry = spend(byFingerprint, measurementFingerprint(measurement));
    if (entry === undefined) return null;
    // The tier that most needs the band. A fingerprint hit means the engine's
    // sentence matched ONCE EVERY NUMBER IN IT WAS REPLACED, so 2.91:1 and
    // 1.02:1 on one element land here as the same violation. Before the band,
    // that was where a real regression went silent.
    return carried(measurement, worstForElement(measurement, measurementElementKey(measurement)));
  });

  // Same check, same page, same element, and the engine's sentence differs.
  // Spent like every other tier, EXCEPT under engine skew, where it is only
  // matched: a new engine may split what one engine reported as a single
  // violation into two rows, and budgeting that would call the second row new
  // on a page nobody edited. Under one engine a second row is a second defect,
  // because the wording cannot have moved on its own.
  const afterElement = tier(afterExact, (measurement) => {
    const key = measurementElementKey(measurement);
    if (engineSkew) {
      if (!elementKeys.has(key)) return null;
      // Matched without spending, so the entry is still in the budget. It is
      // recorded as accounted for all the same: a violation Gate just called
      // pre-existing must never also be counted among the ones that are gone.
      answeredLeniently.add(key);
      return carried(measurement, worstForElement(measurement, key), { detailChanged: true });
    }
    const entry = spend(byElementKey, key);
    if (entry === undefined) return null;
    return carried(measurement, worstForElement(measurement, key), { detailChanged: true });
  });

  const afterDefect = tier(afterElement, (measurement) => {
    const entry = spend(byDefectKey, measurementDefectKey(measurement));
    if (entry === undefined) return null;
    // The element moved, so nothing is recorded under its key. The defect key is
    // the one that matched, and it is the one whose worst band answers here.
    return carried(measurement, worstForDefect(measurement, measurementDefectKey(measurement)), {
      elementChanged: true,
    });
  });

  // Under skew, and only under skew, a violation that missed every key may still
  // be an old one the engine reworded while the markup moved. It is not called
  // pre-existing, because nothing here shows it is the same violation; it is
  // called unclassified, which reports it and gates on nothing. The entry is
  // spent all the same, so two new violations cannot both shelter behind one
  // that vanished, and a violation on a page where nothing went missing still
  // gates normally.
  const introduced = tier(afterDefect, (measurement) =>
    engineSkew &&
    spend(byRouteKind, routeKind(measurement.kind, normalizeRoute(measurement.route))) !== undefined
      ? { measurement, origin: "unclassified" as const, reason: "engine_skew" as const }
      : null,
  );
  // LAST SCREEN BEFORE ANYTHING IS CALLED NEW: a viewport the base run never
  // measured. Widening `viewports:` in the repository config renders the same
  // markup at a size nobody looked at before, and the engine reports a row for
  // it. That row matches no stored entry, because there was never a stored
  // entry to match, and it read as a violation this pull request introduced: a
  // red check on byte-identical HTML, produced by a config edit.
  //
  // Scoped to the violations that would otherwise be NEW, so a violation which
  // matched a stored row is still carried over normally, and scoped to rows
  // measured ONLY where the base did not look: a violation seen at both mobile
  // and a newly added tablet is still answerable against mobile. It joins
  // `route_not_measured` and `check_not_run`, which are the same sentence about
  // a different coordinate: Gate did not look there, so Gate does not guess.
  const baseViewports = snapshot.viewportsMeasured;
  for (const index of introduced) {
    const measurement = all[index]!;
    const unseen =
      baseViewports !== undefined &&
      measurement.viewports.length > 0 &&
      measurement.viewports.every((viewport) => !baseViewports.includes(viewport));
    rows[index] = unseen
      ? { measurement, origin: "unclassified" as const, reason: "viewport_not_measured" as const }
      : { measurement, origin: "introduced" as const };
  }

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
      !claimedEntries.has(index) &&
      !answeredLeniently.has(entry.elementKey),
  ).length;

  return {
    status: "compared",
    baseSha: snapshot.commitSha,
    ...(engineSkew ? { engineSkew } : {}),
    baselineSize: snapshot.entries.length,
    classified,
    introduced: classified.filter((row) => row.origin === "introduced").map((row) => row.measurement),
    preExisting: classified.filter((row) => row.origin === "pre_existing").map((row) => row.measurement),
    // A subset of `preExisting` by construction: `worsened` is only ever set on
    // a row this comparison already placed as pre-existing, so a violation that
    // got worse is counted once as carried over and once as worsened, and never
    // once as new.
    worsened: classified.filter((row) => row.worsened === true).map((row) => row.measurement),
    unclassified: classified.filter((row) => row.origin === "unclassified").map((row) => row.measurement),
    resolved,
  };
}

/**
 * The violations a repository's `rules.measurements: block` may fail a check on
 * live in `measurements.ts` as `gateableMeasurements`, beside the predicate that
 * decides whether a check is blocking at all.
 *
 * They are one rule, and three surfaces read it: the Check Run conclusion, the
 * Check Run's own headline count, and the sentence in the measured block that
 * tells a reader which mode produced their outcome. Two copies of it drifted
 * once already and published a comment stating the wrong mode, so there is one
 * copy, in the module both directions can import without a cycle.
 */

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
