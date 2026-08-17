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
  route_not_measured: "the base run never captured that route",
  check_not_run: "the base run never ran that check",
};

const SHORT_SHA = 7;

function shortSha(sha: string | undefined): string {
  // `sanitizeCodeSpan` returns the span already fenced, so nothing here adds
  // backticks of its own.
  if (!sha) return "the base commit";
  return sanitizeCodeSpan(sha.slice(0, SHORT_SHA), 40);
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

/** The counts line for a comparison that actually happened. */
function comparedHeading(comparison: MeasurementComparison): string {
  const parts = [
    `**${comparison.introduced.length} introduced by this pull request**`,
    `${comparison.preExisting.length} already on the base`,
  ];
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

  if (comparison.introduced.length > 0) {
    const shown = comparison.introduced.slice(0, MAX_MEASUREMENT_LINES);
    const remaining = comparison.introduced.length - shown.length;
    const list = shown.map(measurementLine).join("\n");
    lines.push(`**New in this pull request**\n${list}${remaining > 0 ? `\n…and ${remaining} more` : ""}`);
  } else if (comparison.preExisting.length > 0) {
    // The claim this whole section exists to make say-able. It is only true
    // because a comparable baseline was found, which is why the uncomparable
    // branch above may never reach this sentence, and it claims only the
    // violations Gate could actually PLACE: an unclassified one is not evidence
    // that this pull request added nothing.
    lines.push(
      "No measured violation above is new: every one Gate could place against the base was " +
        "already there before this pull request.",
    );
  }

  if (comparison.preExisting.length > 0) {
    const changed = comparison.classified.filter(
      (row) => row.origin === "pre_existing" && row.detailChanged === true,
    ).length;
    const carried = comparison.preExisting.length;
    lines.push(
      `**Already on the base** — ${carried} of the violation(s) above ` +
        `${carried === 1 ? "was" : "were"} already there before this pull request. ` +
        "They are reported and they never fail a check, whatever `rules.measurements` is set to." +
        (changed > 0
          ? ` ${changed} of them ${changed === 1 ? "is" : "are"} the same defect on the same element ` +
            "with a different measurement, which is a change in degree and not a new violation."
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
    lines.push(
      options.blocking
        ? "This repository sets `rules.measurements: block`, so the new block-eligible violation(s) " +
          "above failed this check. Pre-existing and unclassified violations never do."
        : "This repository sets `rules.measurements: block`. Nothing here failed the check: a " +
          "violation fails one only when it is both new in this pull request and marked " +
          "block-eligible by the engine.",
    );
  }

  return lines.join("\n\n");
}
