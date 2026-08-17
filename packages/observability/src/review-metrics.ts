import { GateMetrics } from "./metrics.js";

/**
 * The published-review counters, recorded from the paths that actually publish.
 *
 * `GateMetrics` has existed, correct and tested, while being instantiated
 * NOWHERE outside its own unit test. Every counter on it read zero forever, and
 * `gate.review.green_over_measured` is the one the measurement decision named as
 * "the one number that would reverse this decision": how often Gate publishes a
 * green check on a page the engine measured a block-eligible violation on. A
 * decision that says it will be revisited from data, wired to an instrument that
 * records nothing, is a decision that will never be revisited.
 *
 * Two outputs, on purpose:
 *
 * 1. OpenTelemetry counters, for an operator who runs a collector. With no
 *    global MeterProvider registered these bind to the API's no-op meter, which
 *    costs nothing and breaks nothing, so this is safe on the Action path inside
 *    a customer's runner where no telemetry is configured at all.
 *
 * 2. ONE log line per published review, with a stable prefix and stable
 *    `key=value` fields. This is the half that matters for a self-hoster: the
 *    numerator and the denominator are each one `grep -c` over the log the
 *    Action or the service already writes, with no observability vendor and no
 *    collector in between. The README documents the two commands.
 */

/** Stable grep anchor. Never change it: an operator's saved query depends on it. */
export const REVIEW_METRIC_PREFIX = "[gate.metric]";

/** Stable event name on the published-review line. */
export const PUBLISHED_REVIEW_EVENT = "gate.review.published";

/** What a published review reports. Every field comes off the delivery decision. */
export interface PublishedReviewFacts {
  /** The Check Run conclusion Gate published. */
  conclusion: string;
  /** Whether the grade reached that conclusion: the denominator. */
  graded?: boolean;
  /** A green check over a measured violation the engine stood behind. */
  greenOverMeasured?: boolean;
  /** Measured violations rendered on the PR surfaces, by kind. */
  measurementKinds?: readonly string[];
  /** Measured violations the repo muted with `rules.measurement_suppress`, by kind. */
  suppressedMeasurementKinds?: readonly string[];
  /** `owner/name`, for the log line only. */
  repository?: string;
  /** PR number, for the log line only. */
  pullRequest?: number;
  /** Head SHA, for the log line only. */
  headSha?: string;
}

export interface RecordPublishedReviewOptions {
  /** Metric facade. Defaults to a process-wide instance over the global meter. */
  metrics?: GateMetrics;
  /** Line sink. Defaults to `console.info`. */
  log?: (line: string) => void;
}

/**
 * One process-wide `GateMetrics`, created on first use.
 *
 * Lazy because the global MeterProvider may be registered after this module is
 * imported, and shared because the constructor registers an observable-gauge
 * callback: one instance per review would leak a callback per review.
 */
let shared: GateMetrics | undefined;
function sharedMetrics(): GateMetrics {
  shared ??= new GateMetrics();
  return shared;
}

/** Test seam: drop the cached instance so a suite can bind a fresh meter. */
export function resetSharedMetrics(): void {
  shared = undefined;
}

const VALUE_MAX = 120;

/**
 * One log field value, reduced to a single token that cannot forge a field.
 *
 * A repository name reaches this from a webhook payload and a SHA from a pull
 * request, so neither is Gate's own string. Flattening whitespace alone is not
 * enough: a newline would forge a second `[gate.metric]` line, and an `=` inside
 * a value would forge a `green_over_measured=true` pair on a review that was
 * nothing of the kind, so an operator's `grep -c` would count a review that
 * never happened. Same class of bug as a finding forging a verdict in the sticky
 * comment, so the same answer: an allowlist, not an escape list. Everything
 * outside the character set a repository, a SHA and a conclusion actually use
 * becomes `_`.
 */
function field(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]/g, "_").slice(0, VALUE_MAX);
}

/** `contrast:2,overflow:1`, in a stable order, or the empty string. */
function byKind(kinds: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${field(kind)}:${count}`)
    .join(",");
}

/**
 * Record one published review: OTel counters plus the greppable line.
 *
 * Returns the line it emitted so a caller (and a test) can assert on exactly
 * what an operator will read.
 */
export function recordPublishedReview(
  facts: PublishedReviewFacts,
  options: RecordPublishedReviewOptions = {},
): string {
  const metrics = options.metrics ?? sharedMetrics();
  const published = facts.measurementKinds ?? [];
  const suppressed = facts.suppressedMeasurementKinds ?? [];

  metrics.recordReviewPublished(facts.graded === true, { conclusion: field(facts.conclusion) });
  for (const kind of published) metrics.recordMeasurementPublished(kind);
  for (const kind of suppressed) metrics.recordMeasurementSuppressed(kind);
  // Attributes stay low-cardinality on purpose: repository and PR number live on
  // the log line, where a per-review value costs nothing, and never on a counter,
  // where one time series per pull request is how a metrics backend falls over.
  if (facts.greenOverMeasured === true) {
    metrics.recordGreenOverMeasured({ conclusion: field(facts.conclusion) });
  }

  const parts = [
    REVIEW_METRIC_PREFIX,
    PUBLISHED_REVIEW_EVENT,
    `conclusion=${field(facts.conclusion)}`,
    `graded=${facts.graded === true}`,
    `green_over_measured=${facts.greenOverMeasured === true}`,
    `measured=${byKind(published)}`,
    `measured_suppressed=${byKind(suppressed)}`,
  ];
  if (facts.repository !== undefined) parts.push(`repo=${field(facts.repository)}`);
  if (facts.pullRequest !== undefined) parts.push(`pr=${facts.pullRequest}`);
  if (facts.headSha !== undefined) parts.push(`sha=${field(facts.headSha)}`);

  const line = parts.join(" ");
  (options.log ?? console.info)(line);
  return line;
}
