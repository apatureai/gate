/**
 * Property-based laws for the free-text secret scrubber (#78). The example
 * tests in scrub-text.test.ts pin known shapes; these properties assert the
 * scrubber's CONTRACT over generated adversarial inputs:
 *
 *   1. No generated secret of a known shape survives scrubbing, wherever it
 *      sits in surrounding text (including when a key=value value overlaps
 *      its own key name, the regression behind the lastIndexOf masking).
 *   2. Scrubbing is idempotent: a second pass never finds new work, so masked
 *      output can be re-scrubbed safely anywhere in the pipeline.
 *   3. scrubTail bounds its output and cannot resurrect a secret at any cap.
 *
 * Property-based coverage for the text scrubber.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scrubTail, scrubText } from "../src/index.js";

const RUNS = { numRuns: 250 };

/** Benign surrounding text that cannot itself form or extend a secret token. */
const benign = fc.string({
  unit: fc.constantFrom(..." \n\tabcdefghij VITE build ready in ms error at line ".split("")),
  maxLength: 60,
});

const alnum = (n: number, max: number) =>
  fc.string({
    unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
    minLength: n,
    maxLength: max,
  });

/** Generated high-confidence secret shapes, one per scrubber pattern family. */
const secretArb: fc.Arbitrary<string> = fc.oneof(
  alnum(30, 40).map((s) => `ghp_${s}`),
  alnum(10, 20).map((s) => `xoxb-${s}`),
  fc
    .string({
      unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
      minLength: 35,
      maxLength: 35,
    })
    .map((s) => `AIza${s}`),
  alnum(20, 30).map((s) => `sk-ant-${s}`),
  fc
    .string({
      unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".split("")),
      minLength: 16,
      maxLength: 16,
    })
    .map((s) => `AKIA${s}`),
  fc
    .tuple(alnum(8, 20), alnum(8, 20), alnum(8, 20))
    .map(([h, p, s]) => `eyJ${h}.eyJ${p}.${s}`),
  alnum(16, 30).map((s) => `Bearer ${s}`),
);

describe("scrubText properties", () => {
  it("no generated secret shape survives, wherever it sits in the text", () => {
    fc.assert(
      fc.property(benign, secretArb, benign, (before, secret, after) => {
        // Whitespace separators preserve the \b word boundaries the patterns rely on.
        const out = scrubText(`${before} ${secret} ${after}`);
        // The distinctive secret core must be gone (suffix after any prefix word).
        const core = secret.split(" ").at(-1) as string;
        expect(out).not.toContain(core);
        expect(out).toContain("[REDACTED");
      }),
      RUNS,
    );
  });

  it("masks key=value assignments even when the value overlaps the key name", () => {
    const keyWord = fc.constantFrom("SECRET", "TOKEN", "PASSWORD", "API_KEY", "ACCESS_KEY");
    const digits = fc.string({
      unit: fc.constantFrom(..."0123456789".split("")),
      minLength: 6,
      maxLength: 24,
    });
    fc.assert(
      fc.property(keyWord, digits, fc.constantFrom("=", ": ", "="), (word, value, sep) => {
        // Adversarial regression: value textually equal to / prefixed by the key word.
        for (const v of [value, word, `${word}${value}`]) {
          if (v.length < 6) continue;
          const out = scrubText(`${word}_${word}${sep}${v}`);
          expect(out).toContain("[REDACTED secret]");
          // Whatever follows the separator must be the mask, not the value.
          expect(out.slice(out.indexOf(sep.trim()) + sep.trim().length).trimStart()).toMatch(
            /^\[REDACTED secret\]/,
          );
        }
      }),
      RUNS,
    );
  });

  it("is idempotent: re-scrubbing masked output changes nothing", () => {
    fc.assert(
      fc.property(benign, secretArb, benign, (before, secret, after) => {
        const once = scrubText(`${before} ${secret} ${after}`);
        expect(scrubText(once)).toBe(once);
      }),
      RUNS,
    );
  });
});

describe("scrubTail properties", () => {
  it("bounds output to maxLen plus the truncation marker, at every cap", () => {
    const marker = "…(truncated)\n";
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), fc.integer({ min: 1, max: 300 }), (text, cap) => {
        const out = scrubTail(text, cap);
        expect(out.length).toBeLessThanOrEqual(cap + marker.length);
      }),
      RUNS,
    );
  });

  it("cannot resurrect a secret at any cap position (scrub-then-cap order)", () => {
    fc.assert(
      fc.property(secretArb, fc.integer({ min: 1, max: 120 }), benign, (secret, cap, after) => {
        const core = secret.split(" ").at(-1) as string;
        const out = scrubTail(`${secret} ${after}`, cap);
        expect(out).not.toContain(core);
      }),
      RUNS,
    );
  });
});
