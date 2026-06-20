import { describe, expect, it } from "vitest";
import {
  createHttpEngineTransport,
  INSTALLATION_HEADER,
  type JobSubmission,
  signEngineRequest,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyEngineRequest,
} from "../src/index.js";

const SECRET = "kms-sourced-hmac-secret";

describe("sign/verify round-trip", () => {
  it("verifies a correctly signed request", () => {
    const body = JSON.stringify({ hello: "world" });
    const headers = signEngineRequest({ body, installationId: "inst_1", secret: SECRET, timestamp: 1000 });
    const result = verifyEngineRequest({
      body,
      installationId: headers[INSTALLATION_HEADER],
      timestamp: headers[TIMESTAMP_HEADER],
      signature: headers[SIGNATURE_HEADER],
      secret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const headers = signEngineRequest({ body: "original", installationId: "inst_1", secret: SECRET });
    const result = verifyEngineRequest({
      body: "tampered",
      installationId: "inst_1",
      timestamp: headers[TIMESTAMP_HEADER],
      signature: headers[SIGNATURE_HEADER],
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a different installationId (cannot misroute tenant)", () => {
    const headers = signEngineRequest({ body: "b", installationId: "inst_1", secret: SECRET });
    const result = verifyEngineRequest({
      body: "b",
      installationId: "inst_2",
      timestamp: headers[TIMESTAMP_HEADER],
      signature: headers[SIGNATURE_HEADER],
      secret: SECRET,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects the wrong secret and a missing signature", () => {
    const headers = signEngineRequest({ body: "b", installationId: "inst_1", secret: SECRET });
    expect(
      verifyEngineRequest({
        body: "b",
        installationId: "inst_1",
        timestamp: headers[TIMESTAMP_HEADER],
        signature: headers[SIGNATURE_HEADER],
        secret: "wrong",
      }).ok,
    ).toBe(false);
    expect(
      verifyEngineRequest({ body: "b", installationId: "inst_1", timestamp: "1", signature: "", secret: SECRET }),
    ).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("enforces timestamp skew when configured", () => {
    const headers = signEngineRequest({ body: "b", installationId: "inst_1", secret: SECRET, timestamp: 1000 });
    const result = verifyEngineRequest({
      body: "b",
      installationId: "inst_1",
      timestamp: headers[TIMESTAMP_HEADER],
      signature: headers[SIGNATURE_HEADER],
      secret: SECRET,
      maxSkewMs: 5000,
      now: 100000,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_skew" });
  });
});

describe("http transport signs submit when an hmac secret is set", () => {
  it("attaches headers the engine can verify over the exact sent body", async () => {
    let captured: { body: string; headers: Record<string, string> } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = { body: String(init.body), headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ jobId: "job_1" }), { status: 202 });
    }) as unknown as typeof fetch;

    const transport = createHttpEngineTransport({
      baseUrl: "https://engine.internal",
      hmacSecret: SECRET,
      fetchImpl,
    });
    const submission: JobSubmission = {
      idempotencyKey: "42:abc",
      depth: "deep",
      request: { installationId: "inst_42" } as never,
    };
    await transport.submit(submission);

    expect(captured?.headers[INSTALLATION_HEADER]).toBe("inst_42");
    const verify = verifyEngineRequest({
      body: captured!.body,
      installationId: captured!.headers[INSTALLATION_HEADER]!,
      timestamp: captured!.headers[TIMESTAMP_HEADER]!,
      signature: captured!.headers[SIGNATURE_HEADER]!,
      secret: SECRET,
    });
    expect(verify.ok).toBe(true);
  });
});
