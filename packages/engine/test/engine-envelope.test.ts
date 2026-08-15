import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import { createHttpEngineTransport, EngineJobError, parseEngineResult, SCHEMA_VERSION } from "../src/index.js";

/**
 * What the engine's wire actually answers, and what Gate makes of it.
 *
 * Each case here was observed against a real `verdict` server
 * (`node packages/serve/dist/main.js --model mock`) before it was written down.
 */
const golden = loadGoldenReviewResult();
const SUBMISSION = {
  idempotencyKey: "gate-review-v2:sha256:abc",
  depth: "triage" as const,
  request: { installationId: "acme/app" } as never,
};

function transportAnswering(handler: (url: string, init: RequestInit) => Response) {
  return createHttpEngineTransport({
    baseUrl: "https://engine.test",
    fetchImpl: (async (url: string, init: RequestInit = {}) => handler(url, init)) as unknown as typeof fetch,
  });
}

describe("409 is two different answers on the engine's wire", () => {
  it("an exact retry returns a job handle and Gate polls it", async () => {
    const transport = transportAnswering(() =>
      new Response(JSON.stringify({ jobId: "job_existing" }), { status: 409 }),
    );
    await expect(transport.submit(SUBMISSION)).resolves.toEqual({ status: 409, jobId: "job_existing" });
  });

  it("a key reused by a DIFFERENT request returns no handle, and Gate says so", async () => {
    // The engine deliberately withholds the other intent's job id here. Reading
    // `jobId` off this body yielded `undefined`, and Gate then polled
    // `GET /jobs/undefined` and reported the ENGINE as broken for the caller's
    // own mistake.
    const transport = transportAnswering(() =>
      new Response(JSON.stringify({ error: "idempotency_conflict" }), { status: 409 }),
    );
    await expect(transport.submit(SUBMISSION)).rejects.toThrow(EngineJobError);
    await expect(transport.submit(SUBMISSION)).rejects.toThrow(/idempotency_conflict/);
    await expect(transport.submit(SUBMISSION)).rejects.toThrow(/already in use by a different request/);
  });

  it("never returns an undefined job id to poll", async () => {
    const transport = transportAnswering(() => new Response("{}", { status: 202 }));
    await expect(transport.submit(SUBMISSION)).rejects.toThrow(EngineJobError);
  });
});

describe("engine failures carry the engine's reason, not just its status", () => {
  it("names a signature mismatch on submit", async () => {
    // The literal body a real verdict returns for a wrong GATE_ENGINE_HMAC_SECRET.
    const transport = transportAnswering(() =>
      new Response(JSON.stringify({ error: "signature_mismatch" }), { status: 401 }),
    );
    await expect(transport.submit(SUBMISSION)).rejects.toThrow(
      "engine submit failed: 401 (signature_mismatch)",
    );
  });

  it("distinguishes an unsigned request from a mis-signed one", async () => {
    const transport = transportAnswering(() =>
      new Response(JSON.stringify({ error: "missing_installation" }), { status: 401 }),
    );
    await expect(transport.submit(SUBMISSION)).rejects.toThrow(/missing_installation/);
  });

  it("names the reason on poll and cancel too", async () => {
    const transport = transportAnswering(() =>
      new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    );
    await expect(transport.poll("job_1", "acme/app")).rejects.toThrow("engine poll failed: 404 (not_found)");
    await expect(transport.cancel("job_1", "acme/app")).rejects.toThrow("engine cancel failed: 404 (not_found)");
  });

  it("still reports the status when the body is not the engine's JSON envelope", async () => {
    const transport = transportAnswering(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await expect(transport.submit(SUBMISSION)).rejects.toThrow("engine submit failed: 502");
  });
});

describe("judgment provenance survives the contract parser", () => {
  it("is preserved, not stripped — the schema is not strict, so it must be named", () => {
    const provenance = {
      model_backed: false,
      source: "canned",
      engine: "verdict-http",
      model: null,
      detail: "verdict ran this review with the mock client",
    };
    const out = parseEngineResult({ ...golden, provenance }, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.provenance).toEqual(provenance);
  });

  it("degrades an unknown `source` rather than failing the parse and blocking publish", () => {
    const out = parseEngineResult(
      {
        ...golden,
        provenance: { model_backed: true, source: "some_future_source", engine: "e", model: "m", detail: "d" },
      },
      SCHEMA_VERSION,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.provenance?.source).toBe("unknown");
  });

  it("refuses a `model_backed` it cannot read rather than guessing it", () => {
    const out = parseEngineResult(
      { ...golden, provenance: { model_backed: "yes", source: "model", engine: "e", model: "m", detail: "d" } },
      SCHEMA_VERSION,
    );
    expect(out.ok).toBe(false);
  });

  it("keeps the omitted case parseable (the pre-stamp wire shape)", () => {
    const out = parseEngineResult(golden, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.provenance).toBeUndefined();
  });
});
