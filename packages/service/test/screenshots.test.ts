import { loadGoldenReviewResult } from "@gate/types";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";
import {
  buildRunUrl,
  buildScreenshotRecords,
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

describe("GET /i/:id.png", () => {
  it("302s to a freshly-signed URL for a live screenshot", async () => {
    app = buildServer();
    registerScreenshotRoute(app, {
      registry: registry([{ findingId: "f_001", objectKey: "shot_001.png", expiresAt: 10_000 }]),
      signer,
      now: () => 5_000,
    });
    const res = await app.inject({ method: "GET", url: "/i/f_001.png" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://signed.example.com/shot_001.png?sig=fresh");
  });

  it("404s for an unknown finding", async () => {
    app = buildServer();
    registerScreenshotRoute(app, { registry: registry([]), signer });
    const res = await app.inject({ method: "GET", url: "/i/missing.png" });
    expect(res.statusCode).toBe(404);
  });

  it("410 tombstones after the retention window (not a broken 302)", async () => {
    app = buildServer();
    registerScreenshotRoute(app, {
      registry: registry([{ findingId: "f_001", objectKey: "shot_001.png", expiresAt: 1_000 }]),
      signer,
      now: () => 9_999,
    });
    const res = await app.inject({ method: "GET", url: "/i/f_001.png" });
    expect(res.statusCode).toBe(410);
  });
});

describe("stable URL helpers", () => {
  it("builds comment-safe stable URLs (no raw signed link)", () => {
    expect(stableScreenshotUrl("https://gate.app/", "f_001")).toBe("https://gate.app/i/f_001.png");
    expect(buildRunUrl("https://gate.app", "run_9")).toBe("https://gate.app/runs/run_9");
  });

  it("builds registry records stamped with the retention deadline", () => {
    const result = loadGoldenReviewResult();
    const records = buildScreenshotRecords(result, 1_000_000);
    expect(records.length).toBe(result.artifacts.annotatedScreenshots.length);
    expect(records[0]?.expiresAt).toBe(1_000_000 + result.screenshotRetentionSeconds * 1000);
    expect(records[0]?.findingId).toBe(result.artifacts.annotatedScreenshots[0]?.findingId);
  });
});
