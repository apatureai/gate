import { describe, expect, it } from "vitest";
import type { NormalizedDesignReviewConfig } from "@gate/types";
import { buildReviewRequest, GATE_GITHUB_PERMISSIONS } from "../src/index.js";

const config: NormalizedDesignReviewConfig = {
  preview: {
    source: "explicit",
    environment: "Preview",
    urlTemplate: null,
    waitSeconds: 0,
    readySelector: null,
    protectionBypassSecretName: null,
    authStateSecretName: null,
  },
  routes: { always: ["/"], maxPerPr: 5, map: {} },
  viewports: ["mobile", "desktop"],
  darkMode: false,
  brand: null,
  rules: { gate: "none", minSeverityToComment: "nit", suppress: [] },
  tokens: { source: null, values: {} },
};

describe("GATE_GITHUB_PERMISSIONS", () => {
  it("never grants contents:write (judgment-only invariant)", () => {
    expect(GATE_GITHUB_PERMISSIONS.contents).toBe("read");
    const values = Object.entries(GATE_GITHUB_PERMISSIONS);
    expect(values.some(([k, v]) => k === "contents" && v === "write")).toBe(false);
  });
});

describe("buildReviewRequest", () => {
  it("shapes inputs into the engine boundary contract", () => {
    const req = buildReviewRequest({
      installationId: "inst_1",
      owner: "acme",
      repoName: "web",
      defaultBranch: "main",
      prNumber: 42,
      headSha: "abc123",
      baseSha: "def456",
      prTitle: "Redesign pricing",
      prBody: null,
      previewUrl: "https://preview.example.com",
      previewProvider: "explicit",
      previewEnvironment: "Preview",
      config,
      publishMode: "advisory",
      depth: "deep",
    });

    expect(req.repository).toEqual({ owner: "acme", name: "web", defaultBranch: "main" });
    expect(req.pullRequest.number).toBe(42);
    expect(req.preview.url).toBe("https://preview.example.com");
    expect(req.depth).toBe("deep");
    expect(req.publishMode).toBe("advisory");
    expect(req.config.rules.gate).toBe("none");
  });
});
