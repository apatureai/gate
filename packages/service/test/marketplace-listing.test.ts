import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATE_APP_PERMISSIONS } from "../src/app-permissions.js";

const listing = readFileSync(
  fileURLToPath(new URL("../../../docs/marketplace-listing.md", import.meta.url)),
  "utf8",
);

describe("Marketplace listing (#24)", () => {
  it("leads with the minimal permissions and never contents:write", () => {
    expect(listing).toContain("checks: write");
    expect(listing).toContain("pull_requests: write");
    expect(listing).toContain("never `contents: write`");
    expect(GATE_APP_PERMISSIONS.contents).toBe("read"); // the doc matches the code
  });

  it("covers pricing, events, and the verification checklist", () => {
    expect(listing).toContain("$20");
    expect(listing).toContain("deployment_status");
    expect(listing.toLowerCase()).toContain("verification checklist");
  });
});
