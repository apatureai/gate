import { describe, expect, it } from "vitest";
import { resolveDeploymentPreview, type DeploymentStatusEvent } from "../src/deployment-preview.js";

function event(overrides: Partial<{ state: string; environment: string; url: string; sha: string; id: number }> = {}): DeploymentStatusEvent {
  return {
    deployment_status: {
      state: overrides.state ?? "success",
      environment_url: overrides.url ?? "https://pr-42.example.vercel.app",
    },
    deployment: {
      id: overrides.id ?? 1001,
      sha: overrides.sha ?? "abc123",
      environment: overrides.environment ?? "Preview",
    },
  };
}

describe("resolveDeploymentPreview", () => {
  it("resolves a successful Preview deployment", async () => {
    const out = await resolveDeploymentPreview(event());
    expect(out).toEqual({
      ok: true,
      url: "https://pr-42.example.vercel.app/",
      sha: "abc123",
      deploymentId: 1001,
      dedupeKey: "abc123:1001",
      source: "deployment_status",
      provider: "vercel",
    });
  });

  it.each([
    ["https://deploy-preview-42--acme.netlify.app", "netlify"],
    ["https://abc123.acme.pages.dev", "cloudflare"],
    ["https://acme-pr-42.onrender.com", "render"],
  ] as const)("classifies %s as %s", async (url, provider) => {
    const out = await resolveDeploymentPreview(event({ url }));
    expect(out).toMatchObject({ ok: true, provider });
  });

  it("rejects an unknown deployment provider instead of misclassifying it", async () => {
    const out = await resolveDeploymentPreview(event({ url: "https://preview.example.com" }));
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("unsupported deployment provider") });
  });

  it("ignores non-success states", async () => {
    expect((await resolveDeploymentPreview(event({ state: "failure" }))).ok).toBe(false);
    expect((await resolveDeploymentPreview(event({ state: "in_progress" }))).ok).toBe(false);
  });

  it("ignores Storybook and non-matching environments", async () => {
    expect((await resolveDeploymentPreview(event({ environment: "storybook" }))).ok).toBe(false);
    expect((await resolveDeploymentPreview(event({ environment: "Production" }))).ok).toBe(false);
  });

  it("honors a configured environment name", async () => {
    const out = await resolveDeploymentPreview(event({ environment: "Deploy Preview" }), { environment: "Deploy Preview" });
    expect(out.ok).toBe(true);
  });

  it("matches the deployment SHA to the PR head SHA when provided", async () => {
    expect((await resolveDeploymentPreview(event({ sha: "abc123" }), { expectedHeadSha: "abc123" })).ok).toBe(true);
    expect((await resolveDeploymentPreview(event({ sha: "old" }), { expectedHeadSha: "new" })).ok).toBe(false);
  });

  it("dedupes on (sha, deployment_id) so a redeploy of the same SHA does not re-trigger", async () => {
    const seen = new Set<string>(["abc123:1001"]);
    const out = await resolveDeploymentPreview(event(), { isDuplicate: (k) => seen.has(k) });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("duplicate") });
  });

  it("rejects a deployment with no usable preview URL", async () => {
    const e = event();
    e.deployment_status!.environment_url = undefined;
    e.deployment_status!.target_url = undefined;
    expect((await resolveDeploymentPreview(e)).ok).toBe(false);
  });
});

describe("custom-domain previews (allowedHostSuffixes)", () => {
  function customEvent(): DeploymentStatusEvent {
    return {
      deployment_status: { state: "success", environment_url: "https://pr-42.preview.acme.com" },
      deployment: { id: 1001, sha: "abc", environment: "Preview" },
    };
  }

  it("rejects an unknown custom domain by default", async () => {
    const out = await resolveDeploymentPreview(customEvent());
    expect(out).toMatchObject({ ok: false });
  });

  it("accepts an allowlisted custom domain, attributed provider 'explicit'", async () => {
    const out = await resolveDeploymentPreview(customEvent(), { allowedHostSuffixes: ["preview.acme.com"] });
    expect(out).toMatchObject({ ok: true, provider: "explicit", url: "https://pr-42.preview.acme.com/" });
  });
});
