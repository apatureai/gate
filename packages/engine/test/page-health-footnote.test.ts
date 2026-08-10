import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import { parseEngineResult, SCHEMA_VERSION } from "../src/index.js";

const golden = loadGoldenReviewResult();

/** Producer-shaped footnotes for the health signals Verdict #20 emits. */
const PRODUCER_FOOTNOTES = {
  console_errors: "1 console error observed during capture.",
  failed_requests: "2 network requests failed during capture.",
  blocked_fonts: "1 web font was blocked and a fallback was substituted.",
  instability: "Layout shifted after first paint (visual instability detected).",
} as const;

describe("pageHealthFootnote contract preservation (gate #156)", () => {
  it("preserves an engine footnote through parseEngineResult, byte-for-value", () => {
    for (const footnote of Object.values(PRODUCER_FOOTNOTES)) {
      const body = { ...golden, artifacts: { ...golden.artifacts, pageHealthFootnote: footnote } };
      const out = parseEngineResult(body, SCHEMA_VERSION);
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result.artifacts.pageHealthFootnote).toBe(footnote);
    }
  });

  it("the clean omitted-field case parses and carries no footnote (older/healthy results)", () => {
    // The golden fixture has no footnote; the additive field is optional.
    const out = parseEngineResult(golden, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.artifacts.pageHealthFootnote).toBeUndefined();
  });

  it("older Gate behavior holds: an additive engine field never breaks parsing", () => {
    // A future engine may add more artifact fields; parsing must still succeed and
    // the known fields survive.
    const body = {
      ...golden,
      artifacts: { ...golden.artifacts, pageHealthFootnote: PRODUCER_FOOTNOTES.console_errors, someFutureField: 42 },
    };
    const out = parseEngineResult(body, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.artifacts.pageHealthFootnote).toBe(PRODUCER_FOOTNOTES.console_errors);
      expect(out.result.artifacts.annotatedScreenshots).toEqual(golden.artifacts.annotatedScreenshots);
    }
  });

  it("the footnote never changes grade — it is preserved alongside an unchanged verdict", () => {
    const body = { ...golden, artifacts: { ...golden.artifacts, pageHealthFootnote: PRODUCER_FOOTNOTES.instability } };
    const out = parseEngineResult(body, SCHEMA_VERSION);
    expect(out.ok && out.result.grade).toBe(golden.grade);
  });
});
