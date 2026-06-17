import { type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";

export const TRACER_NAME = "gate";

/**
 * Span taxonomy covering the full review path (TRD §13):
 * webhook receive -> preview resolve -> enqueue -> engine call -> publish guard
 * -> comment / Check Run.
 */
export const SPAN_NAMES = {
  webhookReceive: "gate.webhook.receive",
  previewResolve: "gate.preview.resolve",
  enqueue: "gate.queue.enqueue",
  engineCall: "gate.engine.call",
  publishGuard: "gate.publish.guard",
  publish: "gate.publish.comment_check_run",
} as const;

export type SpanName = (typeof SPAN_NAMES)[keyof typeof SPAN_NAMES];

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Run `fn` inside an active span, recording success/error status and ending the
 * span. Errors are recorded and re-thrown so callers keep normal control flow.
 */
export async function withSpan<T>(
  name: SpanName,
  fn: (span: Span) => Promise<T>,
  tracer: Tracer = getTracer(),
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof Error) span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}
