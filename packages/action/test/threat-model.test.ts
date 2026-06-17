import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyPreviewHandoff } from "@gate/engine";
import { describe, expect, it } from "vitest";
import { GATE_GITHUB_PERMISSIONS } from "../src/index.js";

const threatModel = readFileSync(
  fileURLToPath(new URL("../../../docs/threat-model-action-path.md", import.meta.url)),
  "utf8",
);

describe("Action-path threat model (#51)", () => {
  it("documents the required sections", () => {
    expect(threatModel).toMatch(/why the app path differs/i);
    expect(threatModel).toMatch(/firecracker/i); // engine sandbox isolates capture
    expect(threatModel).toMatch(/pull_request_target/);
    expect(threatModel).toMatch(/gate-owned/i);
    expect(threatModel).toMatch(/engine-owned/i);
  });

  it("names provenance + fork gating as Gate-owned and SSRF/egress as engine-owned", () => {
    expect(threatModel).toMatch(/provenance/i);
    expect(threatModel).toMatch(/fork gating/i);
    expect(threatModel.toLowerCase()).toContain("ssrf");
  });

  it("re-affirms in code: storageState + bypass disabled on fork PRs before handoff", () => {
    const out = verifyPreviewHandoff({
      url: "https://staging.acme.com",
      source: "explicit",
      provider: "explicit",
      isFork: true,
      protectionBypassSecretName: "BYPASS",
      authStateSecretName: "AUTH",
    });
    expect(out).toMatchObject({ ok: true, protectionBypassSecretName: null, authStateSecretName: null });
  });

  it("re-affirms in code: the Action never requests contents: write", () => {
    expect(GATE_GITHUB_PERMISSIONS.contents).toBe("read");
  });
});
