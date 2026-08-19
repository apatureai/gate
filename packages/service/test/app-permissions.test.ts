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

describe("GATE_APP_EVENTS", () => {
  it("subscribes to push, which is what records a default-branch baseline", () => {
    // Without the subscription the handler exists and is never delivered to, so
    // every merge on a busy repository still leaves the next pull request with
    // `no baseline` and the gate stays silent.
    expect([...GATE_APP_EVENTS]).toEqual(["pull_request", "deployment_status", "push"]);
  });

  it("adds no permission for it", () => {
    // `push` is an event subscription, not a permission: the repository, its
    // default branch, the pushed commit and the installation all arrive in the
    // payload, and the config read is the `contents: read` a review already does.
    // If this ever needed a new scope, the answer is to stop, not to widen.
    expect(GATE_APP_PERMISSIONS).toEqual({
      checks: "write",
      pull_requests: "write",
      contents: "read",
      deployments: "read",
    });
  });
});

describe("buildAppManifest", () => {
  it("declares exactly the minimum scopes, the three events, and documents the rationale", () => {
    const manifest = buildAppManifest({
      name: "Apature Gate",
      url: "https://gate.app",
      webhookUrl: "https://gate.app/webhook",
    });
    expect(manifest.default_permissions).toEqual(GATE_APP_PERMISSIONS);
    expect(manifest.default_events).toEqual([...GATE_APP_EVENTS]);
    expect(manifest.default_events).toContain("push");
    expect("contents" in manifest.default_permissions).toBe(true);
    expect(manifest.default_permissions.contents).toBe("read");
    expect(manifest.description.toLowerCase()).toContain("neutrality guarantee");
    expect(manifest.public).toBe(false);
  });
});
