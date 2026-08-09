import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The deferred-hardening register lives in the README's "Deferred by design"
// section; each item must keep its named trigger.
const doc = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");

describe("deferred hardening roadmap (#54)", () => {
  it("covers all five deferred items with a named trigger each", () => {
    for (const item of ["completion-webhook", "Pact", "JWT", "Inngest", "outbox"]) {
      expect(doc).toContain(item);
    }
    // every item documents a trigger
    expect(doc.match(/\*\*Trigger:\*\*/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("states the invariants that hold across every migration", () => {
    expect(doc).toContain("contents: write");
    expect(doc.toLowerCase()).toContain("stale_publish_rate = 0");
    expect(doc).toContain("publish-time SHA guard");
  });
});
