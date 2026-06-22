import { SCHEMA_VERSION } from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  createSignedUrlResultStorage,
  loadRunResult,
  type ResultStorage,
  type StoredResult,
} from "../src/results.js";

const golden = loadGoldenReviewResult();

function storageOf(stored: StoredResult | null): ResultStorage {
  return { fetch: async () => stored };
}

describe("loadRunResult", () => {
  it("validates and returns the stored result on a matching schema version", async () => {
    const res = await loadRunResult(storageOf({ body: golden, schemaVersion: SCHEMA_VERSION }), "run_1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.grade).toBe(golden.grade);
  });

  it("returns not_found when the object does not exist yet", async () => {
    const res = await loadRunResult(storageOf(null), "run_missing");
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("degrades on a major schema-version mismatch (never a null-grade render)", async () => {
    const res = await loadRunResult(storageOf({ body: golden, schemaVersion: "999" }), "run_1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("schema_version_mismatch");
  });

  it("returns a typed parse error on a shape mismatch", async () => {
    const broken = { ...golden, grade: "not-a-real-grade" };
    const res = await loadRunResult(storageOf({ body: broken, schemaVersion: SCHEMA_VERSION }), "run_1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("schema_parse_error");
  });
});

describe("createSignedUrlResultStorage", () => {
  function fakeFetch(status: number, body: unknown, schemaVersion: string | null): typeof fetch {
    return (async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: schemaVersion ? { "x-schema-version": schemaVersion } : {},
      })) as unknown as typeof fetch;
  }

  it("fetches + parses a signed-URL object and surfaces its schema version", async () => {
    const storage = createSignedUrlResultStorage({
      signUrl: async () => "https://store.example/results/run_1?sig=abc",
      fetchImpl: fakeFetch(200, golden, SCHEMA_VERSION),
    });
    const res = await loadRunResult(storage, "run_1");
    expect(res.ok).toBe(true);
  });

  it("treats a null signed URL as not_found (no object for this run)", async () => {
    const storage = createSignedUrlResultStorage({
      signUrl: async () => null,
      fetchImpl: fakeFetch(200, golden, SCHEMA_VERSION),
    });
    expect(await loadRunResult(storage, "run_x")).toEqual({ ok: false, reason: "not_found" });
  });

  it("treats 404 and 410 (tombstoned) as not_found", async () => {
    for (const status of [404, 410]) {
      const storage = createSignedUrlResultStorage({
        signUrl: async () => "https://store.example/results/run_1",
        fetchImpl: fakeFetch(status, undefined, null),
      });
      expect(await loadRunResult(storage, "run_1")).toEqual({ ok: false, reason: "not_found" });
    }
  });

  it("throws on an unexpected non-OK status (real error, not an empty state)", async () => {
    const storage = createSignedUrlResultStorage({
      signUrl: async () => "https://store.example/results/run_1",
      fetchImpl: fakeFetch(500, undefined, null),
    });
    await expect(loadRunResult(storage, "run_1")).rejects.toThrow(/500/);
  });
});
