import { describe, expect, it } from "vitest";
import {
  type DeploymentStatusEvent,
  filterAppDeployments,
  resolveDeploymentPreview,
  vercelBypassHeaders,
} from "../src/deployment-preview.js";
import { waitForReadiness } from "../src/readiness.js";

function event(environment: string, url: string, id: number, sha = "abc"): DeploymentStatusEvent {
  return {
    deployment_status: { state: "success", environment_url: url },
    deployment: { id, sha, environment },
  };
}

describe("vercelBypassHeaders", () => {
  it("sends the bypass header + cookie flag from the stored secret", () => {
    expect(vercelBypassHeaders("S3CRET")).toEqual({
      "x-vercel-protection-bypass": "S3CRET",
      "x-vercel-set-bypass-cookie": "true",
    });
  });
});

describe("environment allowlist", () => {
  it("accepts an allowlisted environment and rejects others; still ignores storybook", async () => {
    const opts = { allowedEnvironments: ["Preview", "Deploy Preview"] };
    expect((await resolveDeploymentPreview(event("Deploy Preview", "https://x.vercel.app", 1), opts)).ok).toBe(true);
    expect((await resolveDeploymentPreview(event("Production", "https://x.vercel.app", 1), opts)).ok).toBe(false);
    expect((await resolveDeploymentPreview(event("Storybook", "https://x.vercel.app", 1), opts)).ok).toBe(false);
  });
});

describe("filterAppDeployments", () => {
  it("filters a PR's deployments to the app preview and dedupes redeploys", async () => {
    const events = [
      event("Storybook", "https://sb.vercel.app", 10), // ignored
      event("Preview", "https://app.vercel.app", 11), // kept
      event("Preview", "https://app.vercel.app", 11), // duplicate (sha, id) -> dropped
      event("Production", "https://prod.vercel.app", 12), // not allowlisted
    ];
    const kept = await filterAppDeployments(events);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.deploymentId).toBe(11);
  });
});

describe("readiness sends bypass headers", () => {
  it("passes extra headers to the probe", async () => {
    let received: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      received = init.headers as Record<string, string>;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await waitForReadiness({
      url: "https://app.vercel.app",
      headers: vercelBypassHeaders("S3CRET"),
      fetchImpl,
      now: () => 0,
      sleep: async () => {},
    });
    expect(received?.["x-vercel-protection-bypass"]).toBe("S3CRET");
  });
});
