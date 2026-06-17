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
    }
  | { ok: false; reason: string };

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
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

  const url = status.environment_url ?? status.target_url ?? "";
  if (!isHttpUrl(url)) return fail("no valid preview URL on the deployment status");

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

  return { ok: true, url, sha, deploymentId, dedupeKey, source: "deployment_status" };
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
