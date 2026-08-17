import { createHash } from "node:crypto";
import type { Measurement, MeasurementKind } from "@gate/types";

/**
 * What makes one measured violation the SAME violation across two runs.
 *
 * A baseline comparison is only as good as its notion of identity. If the key
 * moves when the page is edited around the defect, every pre-existing violation
 * reappears as "introduced by this pull request" and the merge gate fires on a
 * back catalogue the author never touched. That is the exact failure this whole
 * feature exists to prevent, so the key is chosen to be hard to move.
 *
 * FOUR FIELDS, NONE OF THEM POSITIONAL:
 *
 *   - `kind`     the deterministic check that produced it (`contrast`, ...).
 *   - `route`    the page it was measured on, normalized for trailing slashes.
 *   - `element`  the selector, with every STRUCTURAL-POSITION pseudo-class
 *                removed. `main > li:nth-child(3)` and `main > li:nth-child(4)`
 *                are the same key, because inserting a sibling above a defect
 *                does not create a new defect. `:first-child`, `:last-child`,
 *                `:only-child` and the `-of-type` family go the same way: they
 *                are position under another name, and a run that renamed
 *                `:first-child` into `:nth-child(2)` would otherwise look like a
 *                brand new violation.
 *   - `detail`   the ENGINE's factual sentence with every number replaced by
 *                `#`. "contrast 3.23:1 is below WCAG AA 4.5:1" and
 *                "contrast 3.19:1 is below WCAG AA 4.5:1" are one defect whose
 *                measurement drifted, not two defects. Stripping the magnitudes
 *                is what keeps a one-shade colour change off the gate.
 *
 * WHAT IS DELIBERATELY NOT IN THE KEY:
 *
 *   - `viewports`. The set a violation is measured at follows the repository's
 *     `viewports:` config and the capture that ran, so it moves for reasons that
 *     have nothing to do with the defect. A violation that used to show at
 *     mobile and now also shows at desktop is the same violation.
 *   - `blockEligible`. That is the engine's precision claim about the check, and
 *     it changes when the ENGINE changes. An engine upgrade must never look like
 *     a repository full of new violations.
 *
 * THREE KEYS, NOT ONE, each weaker than the one above it. The full identity is
 * the `fingerprint`. Dropping the detail from it leaves the `elementKey`: same
 * check, same page, same element. Dropping the ELEMENT from it instead leaves
 * the `defectKey`: same check, same page, same stated defect, whatever markup
 * carries it.
 *
 * The comparison treats a fingerprint miss that is an elementKey HIT as still
 * pre-existing, because the alternative is that an engine which rewords its own
 * sentence turns a repository's whole back catalogue into a merge block. The
 * detail therefore decides whether Gate says "unchanged" or "the measurement
 * changed", and never decides whether something gates.
 *
 * THE DEFECT KEY IS FOR THE MARKUP REFACTOR, and it is the one key here that is
 * too weak to be trusted on its own. Position is not the only part of a selector
 * a pull request moves without touching the defect:
 *
 *     #hero .tagline   ->  #hero > .tagline        a combinator was tightened
 *     #hero .tagline   ->  #hero .inner .tagline   a wrapper div was added
 *     #hero .tagline   ->  #hero .subtitle         the class was renamed
 *
 * None of those three is a new contrast failure, and all three move the whole
 * selector path, so no amount of normalizing the path absorbs them. Matching on
 * a stable TAIL or on an id anchor absorbs some and not others: a rename breaks
 * the tail, a wrapper breaks nothing, and a selector with no id has no anchor to
 * fall back to. So the defect key gives up on the path entirely and is carried
 * by three weak signals instead of one strong one: the check, the page, and the
 * substance of what the engine said is wrong.
 *
 * On its own that is far too loose, because two unrelated low-contrast elements
 * on one page produce the same defect key, and a genuinely new one would be
 * absorbed as pre-existing in silence. What makes it safe is not this module but
 * how `compareMeasurementsToBaseline` spends it: a defect-key match CONSUMES a
 * baseline entry that nothing else claimed, so the number of same-defect
 * violations on a route can never grow without something being called
 * introduced. This key answers "which old violation is this the same one as",
 * never "is anything new here".
 *
 * VERSIONED. Any change to the normalization below changes what is the same
 * violation, so it comes with a bump of `MEASUREMENT_IDENTITY_VERSION`. A stored
 * baseline records the version it was computed under, and a comparison across
 * two versions is refused and said out loud rather than silently reporting every
 * measurement as new.
 */

/** Normalization version stamped into every fingerprint and every stored baseline. */
export const MEASUREMENT_IDENTITY_VERSION = "m2";

/** The canonical, comparable form of one measured violation. */
export interface MeasurementIdentity {
  kind: MeasurementKind;
  /** Normalized route. */
  route: string;
  /** Normalized selector, with structural position removed. */
  element: string;
  /** The engine's sentence with magnitudes removed. */
  detail: string;
}

/**
 * Structural-position pseudo-classes, argument and all.
 *
 * These are the parts of a selector that answer "where among its siblings", and
 * they are exactly the parts that move when a pull request adds an element
 * somewhere above the defect. Removing them merges genuine siblings into one
 * key: two identical buttons that both fail contrast become one violation for
 * baseline purposes, so adding a third can go unreported. That is the safe
 * direction of the trade, and the only one available: the other direction
 * reports the untouched back catalogue as this pull request's fault.
 */
const POSITIONAL_PSEUDO =
  /:(?:nth-(?:last-)?(?:child|of-type)\s*\([^)]*\)|(?:first|last|only)-(?:child|of-type))/gi;

/** Every run of digits, with an optional decimal or thousands part. */
const MAGNITUDE = /\d+(?:[.,]\d+)*/g;

/**
 * Route normalization: whitespace collapsed, one trailing slash dropped.
 *
 * Case is preserved because URL paths are case-sensitive, and query strings are
 * preserved because `/search?q=a` and `/search?q=b` really can be different
 * pages. An empty route normalizes to `/` so a producer that reports the site
 * root as `""` and one that reports it as `/` agree.
 */
export function normalizeRoute(route: string): string {
  const collapsed = route.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return "/";
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
  return trimmed.length === 0 ? "/" : trimmed;
}

/**
 * Selector normalization: position removed, combinator spacing made uniform.
 *
 * Class names and attribute values are case-sensitive in CSS, so nothing here
 * lowercases. The spacing pass exists because `div>span` and `div > span` are
 * the same selector and different producers write both.
 */
export function normalizeElement(element: string): string {
  return element
    .replace(POSITIONAL_PSEUDO, "")
    .replace(/\s*([>+~])\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The substance of the engine's sentence: lowercased, magnitudes replaced by `#`.
 *
 * This is the part of the detail that says WHAT is wrong rather than BY HOW
 * MUCH. A contrast ratio that slips from 3.23 to 3.19 between two runs of the
 * same unchanged page is the same defect, and keeping the digits in the key
 * would make every such run look like a fix plus a new violation.
 */
export function detailSubstance(detail: string): string {
  return detail.toLowerCase().replace(MAGNITUDE, "#").replace(/\s+/g, " ").trim();
}

/** The canonical identity of one measured violation. */
export function measurementIdentity(violation: Measurement): MeasurementIdentity {
  return {
    kind: violation.kind,
    route: normalizeRoute(violation.route),
    element: normalizeElement(violation.element),
    detail: detailSubstance(violation.detail),
  };
}

/**
 * `<version>:<sha256>` over the given parts.
 *
 * Joined by NUL, written as an escape so the file stays plain text and its
 * diffs stay reviewable. A printable separator would be ambiguous: a selector
 * or an engine sentence can contain any printable character, so a route ending
 * in one and an element starting with one could hash to the same digest as a
 * different pair.
 */
function digest(parts: readonly string[]): string {
  const hash = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `${MEASUREMENT_IDENTITY_VERSION}:${hash}`;
}

/**
 * Same check, same page, same element. The key a violation must miss before Gate
 * will call it introduced.
 */
export function measurementElementKey(violation: Measurement): string {
  const identity = measurementIdentity(violation);
  return digest([identity.kind, identity.route, identity.element]);
}

/**
 * The full identity, detail included. A hit means "the same violation, worded
 * and measured the same way"; a miss against an elementKey hit means the same
 * defect with a changed measurement.
 *
 * A hash rather than the parts themselves, because a baseline is stored in
 * Gate's own database and Gate stores metadata only: a selector and an engine
 * sentence both derive from the customer's page, and neither has to be kept to
 * answer "is this the same violation".
 */
export function measurementFingerprint(violation: Measurement): string {
  const identity = measurementIdentity(violation);
  return digest([identity.kind, identity.route, identity.element, identity.detail]);
}

/**
 * Same check, same page, same stated defect, WHATEVER MARKUP CARRIES IT.
 *
 * The selector is left out on purpose, which makes this the loosest key Gate
 * computes and the only one that must never be read as an identity by itself:
 * every low-contrast element on one page shares it. It exists so that a pull
 * request which wraps, retitles or re-nests an element around an untouched
 * violation can be shown a candidate to carry that violation over, rather than
 * one violation resolved plus one introduced on markup that changed no colour.
 *
 * The count is what makes it safe. `compareMeasurementsToBaseline` lets a defect
 * key claim only a baseline entry no exact match already claimed, and only once,
 * so this key can move a violation between selectors and can never manufacture
 * room for an extra one.
 */
export function measurementDefectKey(violation: Measurement): string {
  const identity = measurementIdentity(violation);
  return digest([identity.kind, identity.route, identity.detail]);
}
