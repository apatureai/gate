import { z } from "zod";

/**
 * Zod schema for `.gate.yml` (TRD §3, §12). The raw on-disk shape is
 * snake_case; every field has a working default so the file is optional and a
 * missing/empty config is valid. `.strict()` surfaces typos (e.g. `viewport:`)
 * as validation errors rather than silently ignoring them.
 */

export const previewSourceEnum = z.enum([
  "vercel",
  "netlify",
  "cloudflare",
  "render",
  "explicit",
  "local",
]);
export const viewportEnum = z.enum(["mobile", "tablet", "desktop"]);
export const severityEnum = z.enum(["nit", "minor", "major", "blocker"]);
export const gateModeEnum = z.enum(["none", "nits", "blockers"]);
/**
 * What a repo lets the engine's MEASUREMENTS do (`rules.measurements`).
 *
 * A measurement is a contrast ratio, a scroll width or a rectangle the engine
 * computed from the captured DOM with no model involved. It is the
 * best-grounded thing in a review and, until this key existed, the only half a
 * consumer could not see.
 *
 *  - `off`       do not render the measured block. The engine's own grade
 *                retraction still applies: that is computed engine-side and no
 *                repository config can silence it. Gate still says, in one line,
 *                that measurements arrived and are not being shown, because a
 *                setting that makes a surface quietly lie is worse than the
 *                surface being noisy.
 *  - `advisory`  (default) render them, never change the conclusion.
 *  - `block`     let an ENGINE-marked block-eligible violation fail the check.
 *                Opt-in only, exactly like `rules.gate: blockers`, and for the
 *                same reason: the engine does not block on its own authority.
 */
export const measurementsModeEnum = z.enum(["off", "advisory", "block"]);

const previewSchema = z
  .object({
    source: previewSourceEnum.default("vercel"),
    environment: z.string().default("Preview"),
    url_template: z.string().nullable().default(null),
    wait_seconds: z.number().int().min(0).default(0),
    ready_selector: z.string().nullable().default(null),
    // Preview readiness (#80/#151): poll this path instead of the base URL,
    // and/or require an explicit set of acceptable status codes. The Action
    // path defaults to Playwright's set; the hosted App path defaults to 200.
    ready_path: z.string().nullable().default(null),
    ready_status: z.array(z.number().int().min(100).max(599)).nullable().default(null),
    protection_bypass: z.string().nullable().default(null),
    auth: z.string().nullable().default(null),
    // Run the local-serve `preview-command` on FORK PRs (#70). Default off:
    // local-serve runs the PR's own code, and on a fork that is untrusted, so
    // booting a long-lived server under the app's identity must be the repo
    // owner's explicit opt-in. Same-repo PRs always run local-serve.
    fork_preview: z.boolean().default(false),
  })
  .strict()
  .prefault({});

const routesSchema = z
  .object({
    always: z.array(z.string()).default(["/"]),
    max_per_pr: z.number().int().positive().default(5),
    map: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .prefault({});

const rulesSchema = z
  .object({
    gate: gateModeEnum.default("none"),
    min_severity_to_comment: severityEnum.default("nit"),
    suppress: z.array(z.string()).default([]),
    // What the engine's measured facts may do on this repo's PRs. Default
    // `advisory`: shown, never blocking. See `measurementsModeEnum`.
    measurements: measurementsModeEnum.default("advisory"),
    // Measured violations this repo has muted, matched EXACTLY (no glob) against
    // a violation's `element` or its `"<kind>:<element>"` form, the same
    // semantics and the same rationale as `suppress`: pattern semantics are
    // undefined in the config contract, so an ambiguous match is never guessed.
    //
    // Suppression removes a violation from rendering AND from block
    // eligibility. It CANNOT affect the engine's grade retraction, which is
    // computed engine-side from what was measured and never reads repo config.
    measurement_suppress: z.array(z.string()).default([]),
  })
  .strict()
  .prefault({});

const tokensSchema = z
  .object({
    source: z.string().nullable().default(null),
    values: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .prefault({});

export const DesignReviewConfigSchema = z
  .object({
    preview: previewSchema,
    routes: routesSchema,
    viewports: z.array(viewportEnum).min(1).default(["mobile", "desktop"]),
    dark_mode: z.boolean().default(false),
    // Ask the engine to capture each page twice and compare the PNG bytes: the
    // per-review form of verdict's `--verify-stability`. Off by default, since
    // it doubles the screenshot work on every route and viewport. Worth turning
    // on for a page whose animation you believe is frozen and want proof of.
    verify_stability: z.boolean().default(false),
    brand: z.string().nullable().default(null),
    rules: rulesSchema,
    tokens: tokensSchema,
  })
  .strict()
  .prefault({});

export type RawDesignReviewConfig = z.infer<typeof DesignReviewConfigSchema>;
