import { loadGoldenReviewResult } from "@gate/types";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";
import {
  buildRunUrl,
  buildScreenshotRecords,
  capabilityScreenshotUrl,
  mintScreenshotCapability,
  registerScreenshotRoute,
  type ScreenshotRecord,
  type ScreenshotRegistry,
  stableScreenshotUrl,
} from "../src/index.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function registry(records: ScreenshotRecord[]): ScreenshotRegistry {
  return {
    lookup: async (id) => records.find((r) => r.findingId === id) ?? null,
  };
}

const signer = { sign: async (key: string) => `https://signed.example.com/${key}?sig=fresh` };

function record(overrides: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    findingId: "f_001",
    objectKey: "shot_001.png",
    expiresAt: 10_000,
    installationId: "1",
    owner: "acme",
    name: "web",
    visibility: "public",
    ...overrides,
  };
}

describe("GET /i/:id.png — retention + basics", () => {
  it("302s to a freshly-signed URL for a live public screenshot (anonymous)", async () => {
    app = buildServer();
    registerScreenshotRoute(app, { registry: registry([record()]), signer, now: () => 5_000 });
    const res = await app.inject({ method: "GET", url: "/i/f_001.png" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://signed.example.com/shot_001.png?sig=fresh");
  });

  it("404s for an unknown finding", async () => {
    app = buildServer();
    registerScreenshotRoute(app, { registry: registry([]), signer });
    expect((await app.inject({ method: "GET", url: "/i/missing.png" })).statusCode).toBe(404);
  });

  it("410 tombstones after the retention window", async () => {
    app = buildServer();
    registerScreenshotRoute(app, { registry: registry([record({ expiresAt: 1_000 })]), signer, now: () => 9_999 });
    expect((await app.inject({ method: "GET", url: "/i/f_001.png" })).statusCode).toBe(410);
  });
});

describe("GET /i/:id.png — authorization (#61)", () => {
  const SECRET = "cap-secret";
  let signed = 0;
  const countingSigner = { sign: async (key: string) => (signed++, `https://signed.example.com/${key}`) };

  function appWith(records: ScreenshotRecord[], opts: { authorizer?: boolean } = {}) {
    signed = 0;
    const a = buildServer();
    registerScreenshotRoute(a, {
      registry: registry(records),
      signer: countingSigner,
      capabilitySecret: SECRET,
      now: () => 1_000,
      ...(opts.authorizer
        ? {
            authorizer: {
              // A session that may access installation "1" only.
              authorize: (req, rec) => req.headers["x-installation"] === rec.installationId,
            },
          }
        : {}),
    });
    return a;
  }

  it("denies anonymous access to a private artifact (404, signer never called)", async () => {
    app = appWith([record({ visibility: "private", expiresAt: 10_000 })]);
    const res = await app.inject({ method: "GET", url: "/i/f_001.png" });
    expect(res.statusCode).toBe(404); // not 403 — no tenant/key disclosure
    expect(signed).toBe(0);
  });

  it("allows a valid capability scoped to the finding + installation", async () => {
    app = appWith([record({ visibility: "private", expiresAt: 10_000 })]);
    const cap = mintScreenshotCapability({ findingId: "f_001", installationId: "1", exp: 100_000 }, SECRET);
    const res = await app.inject({ method: "GET", url: `/i/f_001.png?cap=${encodeURIComponent(cap)}` });
    expect(res.statusCode).toBe(302);
    expect(signed).toBe(1);
  });

  it("rejects a capability minted for another installation (cross-tenant denial)", async () => {
    app = appWith([record({ visibility: "private", expiresAt: 10_000 })]);
    const cap = mintScreenshotCapability({ findingId: "f_001", installationId: "999", exp: 100_000 }, SECRET);
    const res = await app.inject({ method: "GET", url: `/i/f_001.png?cap=${encodeURIComponent(cap)}` });
    expect(res.statusCode).toBe(404);
    expect(signed).toBe(0);
  });

  it("rejects an expired capability", async () => {
    app = appWith([record({ visibility: "private", expiresAt: 10_000 })]);
    const cap = mintScreenshotCapability({ findingId: "f_001", installationId: "1", exp: 500 }, SECRET); // < now(1000)
    expect((await app.inject({ method: "GET", url: `/i/f_001.png?cap=${cap}` })).statusCode).toBe(404);
  });

  it("authorizes a private artifact via an installation-scoped session", async () => {
    app = appWith([record({ visibility: "private", expiresAt: 10_000 })], { authorizer: true });
    const ok = await app.inject({ method: "GET", url: "/i/f_001.png", headers: { "x-installation": "1" } });
    expect(ok.statusCode).toBe(302);
    const cross = await app.inject({ method: "GET", url: "/i/f_001.png", headers: { "x-installation": "2" } });
    expect(cross.statusCode).toBe(404); // other tenant denied
  });
});

describe("URL + record helpers", () => {
  it("builds public + capability URLs and the run URL", () => {
    expect(stableScreenshotUrl("https://gate.app/", "f_001")).toBe("https://gate.app/i/f_001.png");
    expect(capabilityScreenshotUrl("https://gate.app", "f_001", "tok ax")).toBe("https://gate.app/i/f_001.png?cap=tok%20ax");
    expect(buildRunUrl("https://gate.app", "run_9")).toBe("https://gate.app/runs/run_9");
  });

  it("stamps retention + ownership/visibility on records", () => {
    const result = loadGoldenReviewResult();
    const records = buildScreenshotRecords(result, 1_000_000, {
      installationId: "1",
      owner: "acme",
      name: "web",
      visibility: "private",
    });
    expect(records.length).toBe(result.artifacts.annotatedScreenshots.length);
    expect(records[0]).toMatchObject({ installationId: "1", owner: "acme", name: "web", visibility: "private" });
    expect(records[0]?.expiresAt).toBe(1_000_000 + result.screenshotRetentionSeconds * 1000);
  });
});
