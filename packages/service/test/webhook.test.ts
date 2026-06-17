import { initTelemetry } from "@gate/observability";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("webhook receiver", () => {
  it("accepts pull_request events and dispatches to the handler", async () => {
    const onPullRequest = vi.fn();
    app = buildServer({ webhook: { onPullRequest } });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "pull_request", "x-github-delivery": "d1" },
      payload: { action: "synchronize", number: 42 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true, event: "pull_request" });
    expect(onPullRequest).toHaveBeenCalledWith({ action: "synchronize", number: 42 }, "d1");
  });

  it("accepts deployment_status events", async () => {
    const onDeploymentStatus = vi.fn();
    app = buildServer({ webhook: { onDeploymentStatus } });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "deployment_status" },
      payload: { deployment_status: { state: "success" } },
    });
    expect(res.statusCode).toBe(202);
    expect(onDeploymentStatus).toHaveBeenCalledOnce();
  });

  it("accept-and-ignores unknown events with a 2xx", async () => {
    app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "issues" },
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ignored: true, event: "issues" });
  });
});

describe("health + readiness", () => {
  it("healthz returns ok", async () => {
    app = buildServer();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("readyz reflects the readiness probe", async () => {
    app = buildServer({ readiness: () => false });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ready: false });
  });
});

describe("OTel span per request", () => {
  it("emits a span for each request", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = initTelemetry({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    try {
      app = buildServer();
      await app.inject({ method: "POST", url: "/webhook", headers: { "x-github-event": "issues" }, payload: {} });
      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.some((s) => s.name === "gate.webhook.receive")).toBe(true);
    } finally {
      await telemetry.shutdown();
    }
  });
});
