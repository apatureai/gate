/**
 * Normalized `.gate.yml` configuration (TRD §3).
 *
 * Gate validates and normalizes the raw repo config, then passes these
 * normalized values to `verdict`. Gate does NOT implement design-token
 * extraction itself; that is the engine's job, grounded in the repo's UI DNA.
 */

/** Where the preview deployment comes from. */
export type PreviewSource =
  | "vercel"
  | "netlify"
  | "cloudflare"
  | "render"
  | "explicit"
  | "local";

/** Viewport classes Gate asks the engine to capture. */
export type Viewport = "mobile" | "tablet" | "desktop";

/** Finding severity ladder, lowest to highest. */
export type Severity = "nit" | "minor" | "major" | "blocker";

/**
 * Gate mode (`rules.gate`). Default is `none`: the Check Run never fails unless
 * a repo explicitly opts in (TRD §7). The Check Run only blocks on `blockers`.
 */
export type GateMode = "none" | "nits" | "blockers";

/**
 * What the engine's MEASUREMENTS may do on this repo (`rules.measurements`).
 * `advisory` is the default and the only vendor-set behaviour: measurements are
 * rendered and never change a Check Run conclusion. `block` is a repo owner's
 * explicit policy, the same shape as `rules.gate: blockers`.
 */
export type MeasurementsMode = "off" | "advisory" | "block";

export type NormalizedPreviewConfig = {
  source: PreviewSource;
  /** Provider environment name; defaults to `Preview`. */
  environment: string;
  /** Explicit URL template, or null to rely on discovery. */
  urlTemplate: string | null;
  /**
   * The deployment of the repository's DEFAULT BRANCH, or null.
   *
   * This is the address a push to the default branch is measured at, and it is
   * deliberately not `urlTemplate`: that one names a per-pull-request preview
   * and carries a `{pr}` placeholder that a branch has no value for. `{sha}` and
   * `{short_sha}` are substituted from the pushed commit; a stable production
   * URL needs neither. Null means a push records no baseline, which is where
   * every repository starts.
   */
  defaultBranchUrl: string | null;
  /**
   * The repository's assertion that `defaultBranchUrl` renders like its pull
   * request previews.
   *
   * Read at COMPARISON time, never at record time: a stored set always says
   * where it was actually rendered, so flipping this key takes effect on the
   * next pull request rather than on the next push, and a set recorded under a
   * mistaken claim is not poisoned by it. Default false, which makes a
   * default-branch baseline reportable and never gating.
   */
  defaultBranchRendersLikePreview: boolean;
  /** Seconds to wait after the preview is reachable before capture. */
  waitSeconds: number;
  /** CSS selector signaling the page is ready, or null. */
  readySelector: string | null;
  /** Path to poll for readiness instead of the base URL, or null (Action and App paths). */
  readyPath: string | null;
  /** Explicit acceptable readiness status codes, or null for the path-specific default. */
  readyStatus: number[] | null;
  /** Name of the secret holding a Vercel protection-bypass token; never the secret itself. */
  protectionBypassSecretName: string | null;
  /** Name of the secret holding Playwright storage state; never the secret itself. */
  authStateSecretName: string | null;
  /** Run the local-serve preview-command on fork PRs (#70). Default false. */
  forkPreview: boolean;
};

export type NormalizedRoutesConfig = {
  /** Routes always reviewed. */
  always: string[];
  /** Hard cap on routes reviewed per PR. */
  maxPerPr: number;
  /** Optional mapping from changed paths to routes. */
  map: Record<string, string>;
};

export type NormalizedRulesConfig = {
  gate: GateMode;
  /** Minimum severity that is allowed to post a comment. */
  minSeverityToComment: Severity;
  /** Suppression rules (selectors, finding ids, or patterns). */
  suppress: string[];
  /** What the engine's measured facts may do here. Default `advisory`. */
  measurements: MeasurementsMode;
  /**
   * Measured violations this repo muted, matched exactly against a violation's
   * `element` or `"<kind>:<element>"`. Never affects the engine's own grade
   * retraction, which is computed engine-side and reads no repo config.
   */
  measurementSuppress: string[];
};

/**
 * Design tokens declared by the repo. Gate does NOT extract tokens itself; it
 * passes any declared values and an optional source pointer to the engine, which
 * grounds critique in them alongside the repo's UI DNA.
 */
export type NormalizedTokensConfig = {
  /** Optional pointer to a tokens source (path/URL), or null. */
  source: string | null;
  /** Declared token name -> value (e.g. `color.accent` -> `#5B5BD6`). */
  values: Record<string, string>;
};

export type NormalizedDesignReviewConfig = {
  preview: NormalizedPreviewConfig;
  routes: NormalizedRoutesConfig;
  viewports: Viewport[];
  darkMode: boolean;
  /**
   * Ask the engine to capture each page twice and compare the PNG bytes
   * (`verify_stability` in `.gate.yml`), so a review can state that its capture
   * was verified deterministic rather than merely uncontradicted.
   *
   * Optional, and normalized as PRESENT ONLY WHEN ASKED FOR, on purpose: it
   * crosses to the engine inside this config object, the engine treats it as
   * additive, and a repository that never asked should produce exactly the
   * request Gate sent before the setting existed. An engine that predates the
   * field ignores it either way, so neither side hard-fails on the other.
   */
  verifyStability?: boolean;
  /** Brand block: product description, audience, tone, design rules. */
  brand: string | null;
  rules: NormalizedRulesConfig;
  tokens: NormalizedTokensConfig;
};
