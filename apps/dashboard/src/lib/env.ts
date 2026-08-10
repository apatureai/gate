/**
 * Dashboard app runtime config from env. Read lazily (functions, not top-level
 * throws) so `next build` doesn't require secrets to be present at build time;
 * they're only needed when a request actually runs.
 */
export const SESSION_COOKIE = "gate_session";
export const OAUTH_STATE_COOKIE = "gate_oauth_state";

function read(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Dashboard: missing required env ${name}`);
  return v;
}

export const env = {
  githubClientId: () => read("GITHUB_OAUTH_CLIENT_ID"),
  githubClientSecret: () => read("GITHUB_OAUTH_CLIENT_SECRET"),
  sessionSecret: () => read("DASHBOARD_SESSION_SECRET"),
  /** Public base URL of this dashboard (for OAuth redirect + screenshot links). */
  baseUrl: () => process.env.DASHBOARD_BASE_URL ?? "http://localhost:3000",
  /** Base URL the engine serves stable `/i/<id>.png` screenshots from. */
  artifactBaseUrl: () => process.env.GATE_ARTIFACT_BASE_URL ?? process.env.DASHBOARD_BASE_URL ?? "",
  /** Absolute URL template for stored GateReviewResult JSON; must include `{runId}` when set. */
  resultObjectUrlTemplate: () => process.env.GATE_RESULT_OBJECT_URL_TEMPLATE ?? "",
  /** Secret for minting short-lived screenshot capability tokens (#61). */
  capabilitySecret: () => read("SCREENSHOT_CAPABILITY_SECRET"),
};
