import type { GateReviewRequest } from "@gate/types";

/**
 * App-path preview discovery from the GitHub `deployment_status` webhook
 * (TRD §3.1, §4). The counterpart to the Action-path discovery (#8): filter
 * successful deployments to the configured environment, ignore Storybook/non-app
 * deployments, extract the preview URL, match the SHA, and dedupe on
 * `(sha, deployment_id)` so a redeploy of the same SHA doesn't re-trigger.
 */
export interface DeploymentStatusEvent {
  deployment_status?: {
    state?: string;
    environment?: string;
    environment_url?: string;
    target_url?: string;
  };
  deployment?: {
    id?: number;
    sha?: string;
    environment?: string;
  };
}

export interface DeploymentPreviewOptions {
  /** Required environment name (default "Preview"). */
  environment?: string;
  /** Allowlist of acceptable environment names; overrides `environment` when set. */
  allowedEnvironments?: string[];
  /** Environment-name substrings to ignore (default ["storybook"]). */
  ignoreEnvironments?: string[];
  /** When set, the deployment SHA must equal this PR head SHA. */
  expectedHeadSha?: string;
  /**
   * Operator-allowlisted custom preview host suffixes (e.g. "preview.acme.com").
   * A matching host that isn't a known provider is attributed provider "explicit"
   * — safe because the deployment_status webhook is GitHub-authenticated
   * provenance. Without this, only known provider domains are accepted.
   */
  allowedHostSuffixes?: string[];
  /** Returns true if `(sha, deployment_id)` was already processed. */
  isDuplicate?: (dedupeKey: string) => boolean | Promise<boolean>;
}

/**
 * Vercel protection-bypass headers from the stored secret
 * (`VERCEL_AUTOMATION_BYPASS_SECRET`). Sent on the readiness probe and passed to
 * the engine so a protected preview returns 200 instead of the auth wall. The
 * secret is never logged (TRD §8).
 */
export function vercelBypassHeaders(bypassSecret: string): Record<string, string> {
  return {
    "x-vercel-protection-bypass": bypassSecret,
    "x-vercel-set-bypass-cookie": "true",
  };
}

export type DeploymentPreviewResult =
  | {
      ok: true;
      url: string;
      sha: string;
      deploymentId: number;
      dedupeKey: string;
      source: "deployment_status";
      /** Inferred from the host; "explicit" for an allowlisted custom domain. */
      provider: Exclude<GateReviewRequest["preview"]["provider"], "local">;
    }
  | { ok: false; reason: string };

function parseHttpUrl(value: string): URL | null {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

const PROVIDER_DOMAINS = {
  vercel: ["vercel.app"],
  netlify: ["netlify.app"],
  cloudflare: ["pages.dev"],
  render: ["onrender.com"],
} as const;

function providerForUrl(
  url: URL,
): Exclude<GateReviewRequest["preview"]["provider"], "explicit" | "local"> | null {
  for (const [provider, suffixes] of Object.entries(PROVIDER_DOMAINS)) {
    if (suffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) {
      return provider as Exclude<GateReviewRequest["preview"]["provider"], "explicit" | "local">;
    }
  }
  return null;
}

const fail = (reason: string): DeploymentPreviewResult => ({ ok: false, reason });

export async function resolveDeploymentPreview(
  event: DeploymentStatusEvent,
  options: DeploymentPreviewOptions = {},
): Promise<DeploymentPreviewResult> {
  const status = event.deployment_status;
  const deployment = event.deployment;
  if (!status || !deployment) return fail("not a deployment_status event");

  if (status.state !== "success") return fail(`deployment state is "${status.state}", not success`);

  const environment = (deployment.environment ?? status.environment ?? "").toLowerCase();
  const ignore = (options.ignoreEnvironments ?? ["storybook"]).map((s) => s.toLowerCase());
  if (ignore.some((term) => environment.includes(term))) {
    return fail(`ignored environment "${environment}"`);
  }
  const allowed = (options.allowedEnvironments ?? [options.environment ?? "Preview"]).map((s) =>
    s.toLowerCase(),
  );
  if (!allowed.includes(environment)) {
    return fail(`environment "${environment}" not in allowlist [${allowed.join(", ")}]`);
  }

  const url = parseHttpUrl(status.environment_url ?? status.target_url ?? "");
  if (!url) return fail("no valid preview URL on the deployment status");
  let provider: Exclude<GateReviewRequest["preview"]["provider"], "local"> | null = providerForUrl(url);
  if (!provider) {
    const allowed = (options.allowedHostSuffixes ?? []).some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    );
    if (!allowed) return fail(`unsupported deployment provider for host "${url.hostname}"`);
    provider = "explicit"; // allowlisted custom domain; deployment_status is the provenance
  }

  const sha = deployment.sha;
  if (!sha) return fail("deployment has no sha");
  if (options.expectedHeadSha && options.expectedHeadSha !== sha) {
    return fail("deployment sha does not match the PR head sha");
  }

  const deploymentId = deployment.id;
  if (typeof deploymentId !== "number") return fail("deployment has no id");

  const dedupeKey = `${sha}:${deploymentId}`;
  if (options.isDuplicate && (await options.isDuplicate(dedupeKey))) {
    return fail("duplicate (sha, deployment_id) already processed");
  }

  return {
    ok: true,
    url: url.toString(),
    sha,
    deploymentId,
    dedupeKey,
    source: "deployment_status",
    provider,
  };
}

/**
 * Filter a PR's multiple deployments down to the app preview(s): keep
 * allowlisted, non-Storybook deployments and dedupe redeploys on
 * `(sha, deployment_id)` across the batch (and any external `isDuplicate`).
 */
export async function filterAppDeployments(
  events: DeploymentStatusEvent[],
  options: DeploymentPreviewOptions = {},
): Promise<Array<Extract<DeploymentPreviewResult, { ok: true }>>> {
  const seen = new Set<string>();
  const external = options.isDuplicate;
  const kept: Array<Extract<DeploymentPreviewResult, { ok: true }>> = [];
  for (const event of events) {
    const result = await resolveDeploymentPreview(event, {
      ...options,
      isDuplicate: async (key) => seen.has(key) || (external ? await external(key) : false),
    });
    if (result.ok) {
      seen.add(result.dedupeKey);
      kept.push(result);
    }
  }
  return kept;
}
