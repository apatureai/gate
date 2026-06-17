/**
 * Normalized `.designreview.yml` configuration (TRD §3).
 *
 * Gate validates and normalizes the raw repo config, then passes these
 * normalized values to `judgment-engine`. Gate does NOT implement design-token
 * extraction itself — that is the engine's job grounded in the repo's UI DNA.
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

export type NormalizedPreviewConfig = {
  source: PreviewSource;
  /** Provider environment name; defaults to `Preview`. */
  environment: string;
  /** Explicit URL template, or null to rely on discovery. */
  urlTemplate: string | null;
  /** Seconds to wait after the preview is reachable before capture. */
  waitSeconds: number;
  /** CSS selector signaling the page is ready, or null. */
  readySelector: string | null;
  /** Name of the secret holding a Vercel protection-bypass token; never the secret itself. */
  protectionBypassSecretName: string | null;
  /** Name of the secret holding Playwright storage state; never the secret itself. */
  authStateSecretName: string | null;
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
  /** Brand block: product description, audience, tone, design rules. */
  brand: string | null;
  rules: NormalizedRulesConfig;
  tokens: NormalizedTokensConfig;
};
