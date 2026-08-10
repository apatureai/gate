/**
 * Minimal GitHub App permissions (TRD §11): the neutrality guarantee.
 *
 * Gate requests ONLY these four scopes and NEVER `contents: write`: it is
 * judgment-only and must be unable to edit, commit, or push customer code. That
 * inability is the product promise, not just hygiene: a reviewer that cannot
 * write code cannot be coerced into changing it.
 *
 *   checks: write         publish the design-review Check Run
 *   pull_requests: write  post/update the sticky comment
 *   contents: read        read .designreview.yml and the diff
 *   deployments: read     receive deployment_status for App-path discovery
 */
export const GATE_APP_PERMISSIONS = {
  checks: "write",
  pull_requests: "write",
  contents: "read",
  deployments: "read",
} as const;

export type GateAppPermissions = typeof GATE_APP_PERMISSIONS;

/** Webhook events Gate subscribes to. */
export const GATE_APP_EVENTS = ["pull_request", "deployment_status"] as const;

/** Throws if a permission set would grant write access to repository contents. */
export function assertNoContentsWrite(permissions: Record<string, string>): void {
  if (permissions["contents"] === "write") {
    throw new Error("contents: write is forbidden — Gate is judgment-only (neutrality guarantee)");
  }
}

export interface AppManifestOptions {
  name: string;
  url: string;
  webhookUrl: string;
  redirectUrl?: string;
}

/**
 * Build the GitHub App manifest used by the create-from-manifest install flow
 * (#23). `default_permissions` is exactly the four minimum scopes.
 */
export function buildAppManifest(options: AppManifestOptions) {
  return {
    name: options.name,
    url: options.url,
    description:
      "Judgment-only design review for PR previews. Requests no contents:write — Gate never edits your code (neutrality guarantee).",
    public: false,
    hook_attributes: { url: options.webhookUrl, active: true },
    redirect_url: options.redirectUrl,
    default_permissions: GATE_APP_PERMISSIONS,
    default_events: [...GATE_APP_EVENTS],
  };
}
