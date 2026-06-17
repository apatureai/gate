import { describe, expect, it } from "vitest";
import {
  assertNoContentsWrite,
  buildAppManifest,
  GATE_APP_EVENTS,
  GATE_APP_PERMISSIONS,
} from "../src/app-permissions.js";

describe("GATE_APP_PERMISSIONS", () => {
  it("requests only the four minimum scopes", () => {
    expect(GATE_APP_PERMISSIONS).toEqual({
      checks: "write",
      pull_requests: "write",
      contents: "read",
      deployments: "read",
    });
    expect(Object.keys(GATE_APP_PERMISSIONS)).toHaveLength(4);
  });

  it("never requests contents: write (neutrality guarantee)", () => {
    expect(GATE_APP_PERMISSIONS.contents).toBe("read");
    expect(() => assertNoContentsWrite(GATE_APP_PERMISSIONS)).not.toThrow();
    expect(() => assertNoContentsWrite({ contents: "write" })).toThrow(/judgment-only/);
  });
});

describe("buildAppManifest", () => {
  it("declares exactly the minimum scopes, the two events, and documents the rationale", () => {
    const manifest = buildAppManifest({
      name: "Apature Gate",
      url: "https://gate.app",
      webhookUrl: "https://gate.app/webhook",
    });
    expect(manifest.default_permissions).toEqual(GATE_APP_PERMISSIONS);
    expect(manifest.default_events).toEqual([...GATE_APP_EVENTS]);
    expect("contents" in manifest.default_permissions).toBe(true);
    expect(manifest.default_permissions.contents).toBe("read");
    expect(manifest.description.toLowerCase()).toContain("neutrality guarantee");
    expect(manifest.public).toBe(false);
  });
});
