import { initTelemetry } from "@gate/observability";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  decideReviewDepth,
  recordFullReviewIfDeep,
  traceDepthDecision,
} from "../src/depth-policy.js";
import { createInMemoryFullReviewWindow, FULL_REVIEW_WINDOW_MS } from "../src/review-window.js";

const repo = { owner: "acme", name: "web", prNumber: 42 };

describe("decideReviewDepth", () => {
  it("deep with no prior full review", async () => {
    const store = createInMemoryFullReviewWindow();
    expect(await decideReviewDepth(store, repo, 1_000_000)).toMatchObject({
      depth: "deep",
      reason: "no_prior_full_review",
    });
  });

  it("triage within the window, deep after — composing with re-pushes", async () => {
    const store = createInMemoryFullReviewWindow();
    const t0 = 1_000_000;
    const first = await decideReviewDepth(store, repo, t0);
    await recordFullReviewIfDeep(store, repo, first.depth, t0); // deep ran -> record

    expect(await decideReviewDepth(store, repo, t0 + 30_000)).toMatchObject({
      depth: "triage",
      reason: "within_full_review_window",
    });
    expect(await decideReviewDepth(store, repo, t0 + FULL_REVIEW_WINDOW_MS + 1)).toMatchObject({
      depth: "deep",
      reason: "full_review_window_elapsed",
    });
  });
});

describe("recordFullReviewIfDeep", () => {
  it("records only for deep reviews", async () => {
    const store = createInMemoryFullReviewWindow();
    await recordFullReviewIfDeep(store, repo, "triage", 1000);
    expect(await store.getLastFullReviewAt(repo)).toBeNull();
    await recordFullReviewIfDeep(store, repo, "deep", 2000);
    expect(await store.getLastFullReviewAt(repo)).toBe(2000);
  });
});

describe("traceDepthDecision", () => {
  it("emits a span with depth + reason attributes", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = initTelemetry({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    try {
      traceDepthDecision(repo, { depth: "triage", reason: "within_full_review_window", lastFullReviewAt: 1 });
      const span = exporter.getFinishedSpans().find((s) => s.name === "gate.depth.decision");
      expect(span).toBeDefined();
      expect(span?.attributes["gate.depth"]).toBe("triage");
      expect(span?.attributes["gate.depth_reason"]).toBe("within_full_review_window");
    } finally {
      await telemetry.shutdown();
    }
  });
});
