import { loadGoldenReviewResult } from "@gate/types";
import type { GateReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  createHttpEngineTransport,
  GateReviewResultSchema,
  parseEngineResult,
  SCHEMA_VERSION,
} from "../src/index.js";

const golden = loadGoldenReviewResult();

describe("GateReviewResult contract", () => {
  it("the golden fixture parses and the schema output IS GateReviewResult", () => {
    const result: GateReviewResult = GateReviewResultSchema.parse(golden);
    expect(result.grade).toBe(golden.grade);
    expect(result.metadata.uiDnaVersion).toBe(golden.metadata.uiDnaVersion);
  });

  it("accepts a matching major version (additive minor ok)", () => {
    expect(parseEngineResult(golden, SCHEMA_VERSION).ok).toBe(true);
    expect(parseEngineResult(golden, `${SCHEMA_VERSION}.4.2`).ok).toBe(true);
  });

  it("accepts null uiDnaVersion (repo without extracted UI DNA)", () => {
    const out = parseEngineResult({ ...golden, metadata: { ...golden.metadata, uiDnaVersion: null } }, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
  });

  it("tolerates additive unknown fields (additive-only evolution)", () => {
    const withExtra = { ...golden, futureField: "ignored" };
    const out = parseEngineResult(withExtra, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) expect("futureField" in out.result).toBe(false); // stripped
  });

  it("rejects an unsupported major version (degrade gracefully)", () => {
    const out = parseEngineResult(golden, "2");
    expect(out).toMatchObject({ ok: false, reason: "schema_version_mismatch" });
  });

  it("rejects a missing version header", () => {
    expect(parseEngineResult(golden, null)).toMatchObject({ ok: false, reason: "schema_version_mismatch" });
  });

  it("surfaces a typed parse error on a shape mismatch (never null-grade)", () => {
    const { grade: _removed, ...broken } = golden;
    const out = parseEngineResult(broken, SCHEMA_VERSION);
    expect(out).toMatchObject({ ok: false, reason: "schema_parse_error" });
    if (!out.ok && out.reason === "schema_parse_error") {
      expect(out.issues.join(" ")).toMatch(/grade/);
    }
  });
});

describe("http transport enforces the contract on completed jobs", () => {
  function transportWith(version: string | null, body: unknown) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ jobId: "j", state: "completed", result: body }), {
        status: 200,
        headers: version ? { "x-schema-version": version } : {},
      })) as unknown as typeof fetch;
    return createHttpEngineTransport({ baseUrl: "https://engine.internal", fetchImpl });
  }

  it("returns the parsed result when the version + shape are valid", async () => {
    const status = await transportWith(SCHEMA_VERSION, golden).poll("j");
    expect(status.result?.grade).toBe(golden.grade);
  });

  it("throws (blocks publish) on a version mismatch", async () => {
    await expect(transportWith("2", golden).poll("j")).rejects.toThrow(/contract violation/);
  });

  it("throws on a shape mismatch", async () => {
    const { overall: _drop, ...broken } = golden;
    await expect(transportWith(SCHEMA_VERSION, broken).poll("j")).rejects.toThrow(/contract violation/);
  });
});
