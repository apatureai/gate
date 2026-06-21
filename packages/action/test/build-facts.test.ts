import { describe, expect, it } from "vitest";
import { parsePreviewBuildFacts } from "../src/index.js";

describe("parsePreviewBuildFacts (#70 U1)", () => {
  it("extracts a Vite/webpack failed-compile as a compile_error", () => {
    const out = [
      "vite v5.0.0 dev server running at:",
      "  ➜  Local: http://localhost:3000/",
      "X [ERROR] Failed to compile.",
      "Module not found: Error: Can't resolve './missing'",
    ].join("\n");
    const facts = parsePreviewBuildFacts(out);
    expect(facts.some((f) => f.kind === "compile_error")).toBe(true);
  });

  it("classifies a Next.js hydration mismatch", () => {
    const facts = parsePreviewBuildFacts("Warning: Text content did not match. Hydration failed because the server HTML...");
    expect(facts[0]?.kind).toBe("hydration");
  });

  it("classifies asset/chunk load failures and deprecations", () => {
    const facts = parsePreviewBuildFacts(
      ["GET /fonts/inter.woff2 404 failed to load font", "DeprecationWarning: punycode is deprecated"].join("\n"),
    );
    const kinds = facts.map((f) => f.kind);
    expect(kinds).toContain("asset_error");
    expect(kinds).toContain("deprecation");
  });

  it("ignores clean output and dedupes repeats, capped", () => {
    expect(parsePreviewBuildFacts("ready in 320ms\nLocal: http://localhost:3000")).toEqual([]);
    const repeated = Array.from({ length: 50 }, () => "Warning: same warning").join("\n");
    const facts = parsePreviewBuildFacts(repeated);
    expect(facts).toHaveLength(1); // deduped
  });

  it("strips ANSI color codes before matching", () => {
    const facts = parsePreviewBuildFacts("[31mWarning:[0m unused variable x");
    expect(facts[0]?.kind).toBe("warning");
    expect(facts[0]?.message).not.toContain("");
  });
});
