import { context, propagation } from "@opentelemetry/api";

/**
 * W3C trace-context propagation (gate#161).
 *
 * Inject the ACTIVE OpenTelemetry context into an outbound carrier via the
 * globally-configured propagator, so a Gate span continues into Verdict
 * instead of stopping at the process boundary. We never hand-format a
 * traceparent: `propagation.inject` delegates to the registered W3C propagator,
 * which emits a standards-valid `traceparent` (and `tracestate` when present)
 * for a valid active span context and emits NOTHING for an invalid/absent one
 * (so malformed ambient context is not forwarded).
 *
 * Opaque correlation/run/job ids are deliberately NOT handled here; they stay
 * application headers/attributes and must never be copied into `traceparent`.
 */

/** Inject the active trace context into `carrier` (mutates it), returning the carrier. */
export function injectTraceContext(carrier: Record<string, string>): Record<string, string> {
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** The active trace context as a fresh carrier of W3C headers (empty when no valid context). */
export function traceContextHeaders(): Record<string, string> {
  return injectTraceContext({});
}
