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

    meter
      .createObservableGauge(METRIC_NAMES.queueDepth, { description: "Pending review jobs." })
      .addCallback((observer: ObservableResult) => observer.observe(this.queueDepthProvider()));
  }

  /** A stale review reached publish — this must never happen. */
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
