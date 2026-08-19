import type { MeasurementsMode } from "@gate/types";
import type {
  ClassifiedMeasurement,
  MeasurementComparison,
  UnclassifiedReason,
} from "./measurement-baseline.js";
import { MEASUREMENT_IDENTITY_VERSION } from "./measurement-identity.js";
import { MAX_MEASUREMENT_LINES, measurementLine } from "./measurements.js";
import { sanitizeCodeSpan } from "./sanitize.js";

/**
 * The half of the measured block that says WHOSE violations these are.
 *
 * The measured block above it reports what this run measured. This section
 * reports what of it this pull request is answerable for, and it is rendered as
 * its own section rather than as a column on those rows because its most
 * important output is the case where it has NOTHING to say: no stored baseline.
 * A quiet surface would let "no baseline, so nothing here could be shown to be
 * new" be read as "this pull request introduced nothing", and those are opposite
 * claims. One of them is a fact about the pull request; the other is a fact
 * about Gate's own ignorance.
 *
 * Every sentence here is Gate's own prose over Gate's own counts. The only
 * engine-supplied strings that reach it are routes and the rows of the
 * introduced list, both rendered through the same sanitizers the measured block
 * uses.
 */

/** Heading the scoped section always opens with, whatever it goes on to say. */
export const BASELINE_SECTION_HEADING = "🧬 **Scoped to this pull request**";

/** Why an unclassified violation could not be placed, in a reader's words. */
const UNCLASSIFIED_REASON: Record<UnclassifiedReason, string> = {
  no_baseline: "there is no stored baseline for the base commit",
  baseline_unavailable: "the baseline store could not be read",
  version_skew: "the stored baseline is not comparable to this run",
  // A renamed page lands here, and the wording says so: Gate does not match a
  // violation across two routes, so `/` becoming `/home` is a page it has never
  // seen rather than a page whose violations it can place.
  route_not_measured: "the base run never captured that route, new or renamed",
  check_not_run: "the base run never ran that check",
  // A widened `viewports:` config lands here. The violation may well have been
  // there all along at a size nobody rendered before, so calling it new would
  // fail a build over a config edit.
  viewport_not_measured: "the base run never measured that viewport",
  // Deliberately says what Gate cannot tell rather than what it suspects. The
  // reader's next question is whether to trust the green check, and the honest
  // answer is that one violation on that page went missing and this one could be
  // it wearing new wording.
  engine_skew:
    "a different engine version recorded the baseline and a violation on that page is " +
    "unaccounted for, so a reworded old violation and a new one cannot be told apart",
  // A baseline measured at `preview.default_branch_url` against a run measured
  // at this pull request's preview. Says which two things were compared rather
  // than accusing the environment, because Gate does not know which side the
  // difference came from either.
  cross_environment:
    "the baseline was measured at the default branch's own deployment and this run at this " +
    "pull request's preview, so a violation in one and not the other cannot be attributed",
};

const SHORT_SHA = 7;

function shortSha(sha: string | undefined): string {
  // `sanitizeCodeSpan` returns the span already fenced, so nothing here adds
  // backticks of its own.
  if (!sha) return "the base commit";
  return sanitizeCodeSpan(sha.slice(0, SHORT_SHA), 40);
}

/**
 * An origin as a code span, or a phrase for the recorder that stated none.
 *
 * The origin is repository-supplied text that reaches this process as
 * configuration or as a provider's deployment URL, so it goes through the same
 * sanitizer every other borrowed string on this surface does.
 */
function originPhrase(origin: string | undefined): string {
  return origin ? sanitizeCodeSpan(origin, 200) : "address not recorded";
}

/** Up to `max` distinct routes from a set of rows, as safe code spans. */
function routeList(rows: readonly ClassifiedMeasurement[], max = 4): string {
  const routes = [...new Set(rows.map((row) => row.measurement.route))];
  const shown = routes.slice(0, max).map((route) => sanitizeCodeSpan(route, 120));
  const rest = routes.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * The sentence that has to survive being skimmed: no baseline is not a pass.
 *
 * Worded so that the first four words are the state and the last clause is the
 * consequence, because the failure mode being designed against is a reader who
 * sees a green check and a measured block and concludes the pull request is
 * clean.
 */
function uncomparableParagraph(comparison: MeasurementComparison, mode: MeasurementsMode): string {
  const gateNote =
    mode === "block"
      ? " This repository sets `rules.measurements: block`, and that setting is doing nothing on " +
        "this run: Gate will not fail a check over a violation it cannot show this pull request added."
      : "";
  switch (comparison.status) {
    case "no_baseline":
      return (
        `${BASELINE_SECTION_HEADING} — **no baseline.** Gate has never recorded a measurement set ` +
        `for base commit ${shortSha(comparison.baseSha)}, so none of the violations above can be ` +
        "shown to be new and none of them are gating. This is NOT the same statement as " +
        "\"this pull request introduced no violations\": Gate has not looked at the base, rather than " +
        "looked and found it clean. Run Gate on the base branch to record one." +
        gateNote
      );
    case "unavailable":
      return (
        `${BASELINE_SECTION_HEADING} — **no baseline.** Gate could not read a stored measurement ` +
        `set for base commit ${shortSha(comparison.baseSha)}` +
        (comparison.detail ? ` (${comparison.detail})` : "") +
        ", so none of the violations above can be shown to be new and none of them are gating. " +
        "This is not a statement that the base was clean; it is a statement that Gate does not know." +
        gateNote
      );
    case "version_skew":
    default:
      return (
        `${BASELINE_SECTION_HEADING} — **no usable baseline.** The measurement set stored for base ` +
        `commit ${shortSha(comparison.baseSha)} was recorded under measurement-identity version ` +
        `${sanitizeCodeSpan(comparison.baselineVersion ?? "unknown", 40)}, and this run computes ` +
        `\`${MEASUREMENT_IDENTITY_VERSION}\`. The two cannot be compared, and comparing them anyway ` +
        "would report every violation above as new. Nothing here is gating. The next run on the " +
        "base branch re-records it." +
        gateNote
      );
  }
}

/**
 * A row's band change, as the reader's own words rather than two bare numbers.
 *
 * Written out only where both bands are known, which is the only state that ever
 * reaches this: a row with an unknown band on either side is not worsened and is
 * never listed here. Ordinal and within one check, so it is deliberately not
 * dressed up as a magnitude, a percentage or a delta.
 */
function bandChange(row: ClassifiedMeasurement): string {
  return ` _[severity band ${row.baselineSeverity} on the base, ${row.currentSeverity} here]_`;
}

/** The counts line for a comparison that actually happened. */
function comparedHeading(comparison: MeasurementComparison): string {
  const parts = [
    `**${comparison.introduced.length} introduced by this pull request**`,
  ];
  // Its own count, beside the introduced one and never folded into it. Folding
  // would make a pull request that added nothing and broke something read as if
  // it had added something, and a reader cannot un-see a wrong number.
  if (comparison.worsened.length > 0) {
    parts.push(`**${comparison.worsened.length} already on the base and made worse here**`);
  }
  parts.push(`${comparison.preExisting.length} already on the base`);
  if (comparison.unclassified.length > 0) {
    parts.push(`${comparison.unclassified.length} not classified`);
  }
  const recorded =
    comparison.baselineSize === 0
      ? "which recorded no violations on the routes and checks it covered"
      : `which recorded ${comparison.baselineSize} violation(s)`;
  return (
    `${BASELINE_SECTION_HEADING} — compared against the measurement set stored for base ` +
    `${shortSha(comparison.baseSha)}, ${recorded}: ${parts.join(", ")}.`
  );
}

/**
 * The scoped section, or `null` when there is nothing to scope.
 *
 * `off` renders nothing: the measured block has already told the reader that
 * measurements arrived and their repository asked for them not to be shown, and
 * a scoping section under that setting would print the same evidence through a
 * second door.
 */
export function baselineSection(
  comparison: MeasurementComparison,
  options: { mode?: MeasurementsMode; blocking?: boolean } = {},
): string | null {
  const mode = options.mode ?? "advisory";
  if (mode === "off") return null;
  if (comparison.classified.length === 0 && comparison.resolved === 0) return null;

  if (comparison.status !== "compared") {
    if (comparison.classified.length === 0) return null;
    return uncomparableParagraph(comparison, mode);
  }

  const lines = [comparedHeading(comparison)];

  // Said whenever the two engines differ, not only when a row was withheld,
  // because the reader is being told which rulebook produced the counts above.
  // A run that quietly used a weaker rule and a run that used the normal one
  // must not print the same page.
  if (comparison.engineSkew) {
    lines.push(
      "ℹ️ The baseline was recorded by engine " +
        `${sanitizeCodeSpan(comparison.engineSkew.baseline, 60)} and this run is engine ` +
        `${sanitizeCodeSpan(comparison.engineSkew.current, 60)}. An engine can reword its own ` +
        "findings, so on any page where a recorded violation is unaccounted for, a violation here " +
        "that matches nothing is reported as not classified instead of new. It is not being called " +
        "pre-existing, and it is not gating. The next run on the base branch re-records the " +
        "baseline under this engine and restores the normal rule.",
    );
  }

  // Said whenever the two sides were rendered by different deployments, not only
  // when a row was withheld, for the reason the engine-skew note above is
  // unconditional: the counts a reader is about to act on were produced under a
  // weaker rule, and a run that withheld attribution must not print the same
  // page as one that had nothing to withhold.
  if (comparison.crossEnvironment) {
    lines.push(
      "ℹ️ The baseline was measured at the default branch's own deployment " +
        `(${originPhrase(comparison.crossEnvironment.baseline.origin)}) and this run at this pull ` +
        `request's preview (${originPhrase(comparison.crossEnvironment.current.origin)}). Those two ` +
        "can differ for reasons no pull request caused: seed data, feature flags, a signed-out " +
        "state, a consent banner, a different CDN. So a violation here that matches nothing on the " +
        "base is reported as not classified rather than new, a severity band that moved is not " +
        "called worse, and no recorded violation is counted as resolved. Violations that DID match " +
        "the base are still reported as already there. Nothing on this run is gating. If your " +
        "default branch deploys to something that renders like your previews, set " +
        "`preview.default_branch_renders_like_preview: true` to compare them normally.",
    );
  }

  if (comparison.introduced.length > 0) {
    const shown = comparison.introduced.slice(0, MAX_MEASUREMENT_LINES);
    const remaining = comparison.introduced.length - shown.length;
    const list = shown.map(measurementLine).join("\n");
    lines.push(`**New in this pull request**\n${list}${remaining > 0 ? `\n…and ${remaining} more` : ""}`);
  }

  // Its OWN section, between the new ones and the carried-over ones, because it
  // is neither. The sentence a reader has to leave with is that this violation
  // was already here and this pull request made it materially worse, which is
  // true, and is different from "new". Folding it into either neighbour loses
  // one half of that: filed as new it accuses an author of markup they did not
  // write, filed as an ordinary carry-over it says nothing happened.
  if (comparison.worsened.length > 0) {
    const rows = comparison.classified.filter((row) => row.worsened === true);
    const shown = rows.slice(0, MAX_MEASUREMENT_LINES);
    const remaining = rows.length - shown.length;
    const list = shown.map((row) => `${measurementLine(row.measurement)}${bandChange(row)}`).join("\n");
    lines.push(
      "**Made worse by this pull request**\nEach of these was already on the base and this pull " +
        "request moved it into a worse severity band, which the engine states and Gate compares. " +
        "They are not new violations, and they are not unchanged ones. The band is ordinal and " +
        "comparable only within one check; Gate never sees the measurement behind it.\n" +
        `${list}${remaining > 0 ? `\n…and ${remaining} more` : ""}`,
    );
  }

  if (comparison.introduced.length === 0 && comparison.worsened.length === 0 && comparison.preExisting.length > 0) {
    // The claim this whole section exists to make say-able. It is only true
    // because a comparable baseline was found, which is why the uncomparable
    // branch above may never reach this sentence, and it claims only the
    // violations Gate could actually PLACE: an unclassified one is not evidence
    // that this pull request added nothing.
    lines.push(
      "No measured violation above is new: every one Gate could place against the base was " +
        "already there before this pull request." +
        // The hedge in that sentence is doing real work, and a reader skimming
        // will not weigh it. A pull request that adds a breakpoint and a
        // violation only visible at it produces exactly this shape: nothing
        // placed, nothing gating, and a green check. Say the number out loud so
        // the qualifier cannot be read past.
        (comparison.unclassified.length > 0
          ? ` It is not a statement about the ${comparison.unclassified.length} violation(s) Gate ` +
            "could not place, listed below. Those are neither new nor carried over as far as Gate " +
            "knows, and none of them can fail this check."
          : ""),
    );
  }

  if (comparison.preExisting.length > 0) {
    const changed = comparison.classified.filter(
      (row) => row.origin === "pre_existing" && row.detailChanged === true,
    ).length;
    // Same defect, same page, different markup: a wrapper, a tightened
    // combinator, a renamed class. Said out loud rather than folded into the
    // count, because it is the one carry-over Gate reached by a weaker key than
    // the selector, and a reader is entitled to know which ones those were.
    const remarked = comparison.classified.filter(
      (row) => row.origin === "pre_existing" && row.elementChanged === true,
    ).length;
    const carried = comparison.preExisting.length;
    // The blanket "these never fail a check" is TRUE only while none of them got
    // worse, and a worsened violation is a pre-existing one. Left unqualified it
    // would be the one sentence on this surface that contradicts the red check
    // beside it, so when any of these gated, the count that did is named and the
    // promise is made about the rest.
    const worsened = comparison.worsened.length;
    const neverGates =
      worsened === 0
        ? "They are reported and they never fail a check, whatever `rules.measurements` is set to."
        : `${worsened} of them ${worsened === 1 ? "is" : "are"} listed above as made worse, and ` +
          "under `rules.measurements: block` a worsened violation can fail this check. The rest " +
          "are reported and never do, whatever `rules.measurements` is set to.";
    lines.push(
      `**Already on the base** — ${carried} of the violation(s) above ` +
        `${carried === 1 ? "was" : "were"} already there before this pull request. ` +
        neverGates +
        (changed > 0
          ? ` ${changed} of them ${changed === 1 ? "is" : "are"} the same defect on the same element ` +
            "with a different measurement, which is a change in degree and not a new violation."
          : "") +
        (remarked > 0
          ? ` ${remarked} of them ${remarked === 1 ? "is" : "are"} the same defect on the same page ` +
            "carried by a different selector, which is a markup change and not a new violation."
          : ""),
    );
  }

  if (comparison.unclassified.length > 0) {
    const rows = comparison.classified.filter((row) => row.origin === "unclassified");
    const byReason = new Map<UnclassifiedReason, ClassifiedMeasurement[]>();
    for (const row of rows) {
      const reason = row.reason ?? "no_baseline";
      byReason.set(reason, [...(byReason.get(reason) ?? []), row]);
    }
    const detail = [...byReason.entries()]
      .map(
        ([reason, group]) =>
          `${group.length} because ${UNCLASSIFIED_REASON[reason]} (${routeList(group)})`,
      )
      .join("; ");
    lines.push(
      `**Not classified** — ${comparison.unclassified.length} of the violation(s) above could not ` +
        `be placed against the base: ${detail}. Gate does not guess which side of this pull ` +
        "request they came from, so they are reported and never gated.",
    );
  }

  if (comparison.resolved > 0) {
    lines.push(
      `✅ ${comparison.resolved} violation(s) recorded on the base are gone from the routes and ` +
        "checks this run measured.",
    );
  }

  if (mode === "block") {
    // Worded from what actually gated, not from what is merely present: a
    // worsened violation the engine will not stand behind is on the page and is
    // not the reason for anything, and naming it here would send an author to
    // fix the wrong row.
    const worsenedGating = comparison.worsened.filter((violation) => violation.blockEligible).length;
    // Named on the surface, not only in the README. Without this the green run
    // that carries a deepened overflow printed a row satisfying every condition
    // the closing sentence listed, and then said nothing failed: an explanation
    // that contradicts the evidence directly above it is worse than no
    // explanation, because a reader concludes the check is broken.
    const excludedByKind = comparison.worsened.some(
      (violation) => violation.blockEligible && violation.kind === "overflow",
    );
    const overflowNote = excludedByKind
      ? " One violation above is an `overflow` that deepened. Gate reports those and never fails a " +
        "check on one, because the overflow severity bands are cut at shares of the viewport that " +
        "an unrelated layout edit can cross. An `overflow` this pull request introduced still fails."
      : "";
    lines.push(
      options.blocking
        ? worsenedGating > 0
          ? "This repository sets `rules.measurements: block`, so the block-eligible violation(s) " +
            "above that this pull request either introduced or moved into a worse severity band " +
            "failed this check. A pre-existing violation whose band did not move never does, and " +
            "neither does an unclassified one." +
            overflowNote
          : "This repository sets `rules.measurements: block`, so the new block-eligible violation(s) " +
            "above failed this check. Pre-existing and unclassified violations never do." +
            overflowNote
        : "This repository sets `rules.measurements: block`. Nothing here failed the check: a " +
          "violation fails one only when the engine marked it block-eligible and it is either new " +
          "in this pull request or one this pull request moved into a worse severity band, with a " +
          "band known on both sides." +
          // Without this the sentence above lists conditions no violation on
          // this run could have met, and a reader concludes the pull request is
          // clean. The setting is not doing nothing because there was nothing to
          // find; it is doing nothing because Gate refused to attribute what it
          // found, and those read very differently.
          (comparison.crossEnvironment
            ? " On this run nothing could meet those conditions: the two sides were rendered by " +
              "different deployments, so `block` is switched off here whatever this pull request did."
            : "") +
          overflowNote,
    );
  }

  return lines.join("\n\n");
}
