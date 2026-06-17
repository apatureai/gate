import { describe, expect, it } from "vitest";
import { createAccountEngineTransport, resolveEngineRoute } from "../src/endpoint-routing.js";

const HOSTED = "https://engine.apature.dev";

describe("resolveEngineRoute", () => {
  it("defaults to the hosted engine", () => {
    expect(resolveEngineRoute({}, HOSTED)).toEqual({ endpoint: HOSTED, inVpc: false, noFallback: false });
    expect(resolveEngineRoute({ engineEndpoint: null }, HOSTED).inVpc).toBe(false);
  });

  it("routes to a configured in-VPC endpoint with no fallback", () => {
    expect(resolveEngineRoute({ engineEndpoint: "https://engine.internal.acme" }, HOSTED)).toEqual({
      endpoint: "https://engine.internal.acme",
      inVpc: true,
      noFallback: true,
    });
  });
});

describe("createAccountEngineTransport", () => {
  it("sends an in-VPC account's jobs only to its endpoint, never hosted — even on failure", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response("", { status: 503 }); // in-VPC engine is down
    }) as unknown as typeof fetch;

    const { transport, route } = createAccountEngineTransport(
      { engineEndpoint: "https://engine.internal.acme" },
      { hostedEndpoint: HOSTED, fetchImpl },
    );
    expect(route.inVpc).toBe(true);

    // The submit fails (no silent fallback to hosted).
    await expect(
      transport.submit({ idempotencyKey: "1:a", depth: "deep", request: { installationId: "1" } as never }),
    ).rejects.toThrow();

    expect(urls.every((u) => u.startsWith("https://engine.internal.acme"))).toBe(true);
    expect(urls.some((u) => u.startsWith(HOSTED))).toBe(false); // never leaked to hosted
  });

  it("routes hosted accounts to the hosted endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ jobId: "j" }), { status: 202 });
    }) as unknown as typeof fetch;
    const { transport } = createAccountEngineTransport({}, { hostedEndpoint: HOSTED, fetchImpl });
    await transport.submit({ idempotencyKey: "1:a", depth: "deep", request: { installationId: "1" } as never });
    expect(urls[0]?.startsWith(HOSTED)).toBe(true);
  });
});
