import {
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  metrics,
  type ObservableResult,
} from "@opentelemetry/api";

export const METER_NAME = "gate";

export const METRIC_NAMES = {
  /** Hard invariant (§15.3): must stay 0. Alert fires on any non-zero value. */
  stalePublish: "gate.stale_publish",
  reviewLatency: "gate.review.latency_ms",
  timeToFirstComment: "gate.review.time_to_first_comment_ms",
  queueDepth: "gate.queue.depth",
  engineErrors: "gate.engine.errors",
  captureInstability: "gate.capture.instability",
  engineSubmitLatency: "gate.engine.submit_latency_ms",
  enginePollCount: "gate.engine.poll_count",
  engineCancels: "gate.engine.cancels",
  engineTimeouts: "gate.engine.timeouts",
  /**
   * Reviews that published a GREEN check while carrying an unsuppressed,
   * engine-block-eligible measured violation.
   *
   * This is the hole the measurement decision deliberately left open, priced.
   * A model that returns one unrelated nit while ignoring a measured WCAG AA
   * contrast failure grades `ship_with_nits`, which maps to `success`, with the
   * violation printed underneath the tick. Above roughly 5% of graded runs, the
   * retraction predicate is too narrow to be the whole answer and flooring the
   * grade on measurements is the right reversal.
   */
  greenOverMeasured: "gate.review.green_over_measured",
  /**
   * Every review Gate published, attributed by `graded`: whether the grade
   * reached the Check Run at all.
   *
   * The denominator `greenOverMeasured` is read against. The reversal threshold
   * is stated as a share of GRADED runs, and an unjudged, nothing-reviewed or
   * grade-retracted run can never be green over anything, so counting it below
   * the line would dilute the number the decision said it would be reversed by.
   */
  reviewsPublished: "gate.review.published",
  /**
   * Measured violations a repository muted with `rules.measurement_suppress`,
   * by kind. The proxy for each check's false-positive rate on real
   * repositories. Above roughly 15% of what is published for a kind, the fix is
   * to stop emitting that kind, not to add more configuration.
   */
  measurementSuppressed: "gate.review.measurement_suppressed",
  /** Measured violations published, by kind: the denominator for the above. */
  measurementsPublished: "gate.review.measurements_published",
} as const;

/**
 * Typed facade over the Gate metric instruments (TRD §13, §15.3/§15.6). Build it
 * from a Meter; in production the global meter is wired by `initTelemetry`.
 */
export class GateMetrics {
  private readonly stalePublish: Counter;
  private readonly reviewLatency: Histogram;
  private readonly timeToFirstComment: Histogram;
  private readonly engineErrors: Counter;
  private readonly captureInstability: Histogram;
  private readonly engineSubmitLatency: Histogram;
  private readonly enginePollCount: Histogram;
  private readonly engineCancels: Counter;
  private readonly engineTimeouts: Counter;
  private readonly greenOverMeasured: Counter;
  private readonly reviewsPublished: Counter;
  private readonly measurementSuppressed: Counter;
  private readonly measurementsPublished: Counter;
  private queueDepthProvider: () => number = () => 0;

  constructor(meter: Meter = metrics.getMeter(METER_NAME)) {
    this.stalePublish = meter.createCounter(METRIC_NAMES.stalePublish, {
      description: "Stale reviews published. Hard invariant: must stay 0.",
    });
    this.reviewLatency = meter.createHistogram(METRIC_NAMES.reviewLatency, { unit: "ms" });
    this.timeToFirstComment = meter.createHistogram(METRIC_NAMES.timeToFirstComment, { unit: "ms" });
    this.engineErrors = meter.createCounter(METRIC_NAMES.engineErrors);
    this.captureInstability = meter.createHistogram(METRIC_NAMES.captureInstability, {
      description: "Capture-instability ratio from engine result metadata (0..1).",
    });
    this.engineSubmitLatency = meter.createHistogram(METRIC_NAMES.engineSubmitLatency, { unit: "ms" });
    this.enginePollCount = meter.createHistogram(METRIC_NAMES.enginePollCount, {
      description: "Number of GET /jobs polls per review.",
    });
    this.engineCancels = meter.createCounter(METRIC_NAMES.engineCancels);
    this.engineTimeouts = meter.createCounter(METRIC_NAMES.engineTimeouts);
    this.greenOverMeasured = meter.createCounter(METRIC_NAMES.greenOverMeasured, {
      description: "Green checks published over an unsuppressed block-eligible measured violation.",
    });
    this.reviewsPublished = meter.createCounter(METRIC_NAMES.reviewsPublished, {
      description: "Reviews published, attributed by whether the grade reached the check.",
    });
    this.measurementSuppressed = meter.createCounter(METRIC_NAMES.measurementSuppressed, {
      description: "Measured violations muted by rules.measurement_suppress, by kind.",
    });
    this.measurementsPublished = meter.createCounter(METRIC_NAMES.measurementsPublished, {
      description: "Measured violations rendered on a PR surface, by kind.",
    });

    meter
      .createObservableGauge(METRIC_NAMES.queueDepth, { description: "Pending review jobs." })
      .addCallback((observer: ObservableResult) => observer.observe(this.queueDepthProvider()));
  }

  /** A stale review reached publish. This must never happen. */
  recordStalePublish(attributes?: Attributes): void {
    this.stalePublish.add(1, attributes);
  }

  recordReviewLatency(ms: number, attributes?: Attributes): void {
    this.reviewLatency.record(ms, attributes);
  }

  recordTimeToFirstComment(ms: number, attributes?: Attributes): void {
    this.timeToFirstComment.record(ms, attributes);
  }

  recordEngineError(attributes?: Attributes): void {
    this.engineErrors.add(1, attributes);
  }

  /** A green check went out over a measured violation the engine stood behind. */
  recordGreenOverMeasured(attributes?: Attributes): void {
    this.greenOverMeasured.add(1, attributes);
  }

  /** A review reached the pull request. `graded` separates the denominator. */
  recordReviewPublished(graded: boolean, attributes?: Attributes): void {
    this.reviewsPublished.add(1, { ...attributes, graded });
  }

  /** A repo muted a measured violation of this kind. */
  recordMeasurementSuppressed(kind: string, attributes?: Attributes): void {
    this.measurementSuppressed.add(1, { ...attributes, kind });
  }

  /** A measured violation of this kind was rendered on a PR surface. */
  recordMeasurementPublished(kind: string, attributes?: Attributes): void {
    this.measurementsPublished.add(1, { ...attributes, kind });
  }

  recordCaptureInstability(ratio: number, attributes?: Attributes): void {
    this.captureInstability.record(ratio, attributes);
  }

  recordEngineSubmitLatency(ms: number, attributes?: Attributes): void {
    this.engineSubmitLatency.record(ms, attributes);
  }

  recordEnginePollCount(count: number, attributes?: Attributes): void {
    this.enginePollCount.record(count, attributes);
  }

  recordEngineCancel(attributes?: Attributes): void {
    this.engineCancels.add(1, attributes);
  }

  recordEngineTimeout(attributes?: Attributes): void {
    this.engineTimeouts.add(1, attributes);
  }

  /** Register a callback the queue-depth observable gauge reads on collection. */
  setQueueDepthProvider(provider: () => number): void {
    this.queueDepthProvider = provider;
  }
}
