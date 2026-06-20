import { z } from "zod";

/**
 * Zod schema for `.designreview.yml` (TRD §3, §12). The raw on-disk shape is
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

const previewSchema = z
  .object({
    source: previewSourceEnum.default("vercel"),
    environment: z.string().default("Preview"),
    url_template: z.string().nullable().default(null),
    wait_seconds: z.number().int().min(0).default(0),
    ready_selector: z.string().nullable().default(null),
    protection_bypass: z.string().nullable().default(null),
    auth: z.string().nullable().default(null),
    // Run the local-serve `preview-command` on FORK PRs (#70). Default off:
    // local-serve runs the PR's own code, and on a fork that is untrusted, so
    // booting a long-lived server under the app's identity must be the repo
    // owner's explicit opt-in. Same-repo PRs always run local-serve.
    fork_preview: z.boolean().default(false),
  })
  .strict()
  .default({});

const routesSchema = z
  .object({
    always: z.array(z.string()).default(["/"]),
    max_per_pr: z.number().int().positive().default(5),
    map: z.record(z.string()).default({}),
  })
  .strict()
  .default({});

const rulesSchema = z
  .object({
    gate: gateModeEnum.default("none"),
    min_severity_to_comment: severityEnum.default("nit"),
    suppress: z.array(z.string()).default([]),
  })
  .strict()
  .default({});

const tokensSchema = z
  .object({
    source: z.string().nullable().default(null),
    values: z.record(z.string()).default({}),
  })
  .strict()
  .default({});

export const DesignReviewConfigSchema = z
  .object({
    preview: previewSchema,
    routes: routesSchema,
    viewports: z.array(viewportEnum).min(1).default(["mobile", "desktop"]),
    dark_mode: z.boolean().default(false),
    brand: z.string().nullable().default(null),
    rules: rulesSchema,
    tokens: tokensSchema,
  })
  .strict()
  .default({});

export type RawDesignReviewConfig = z.infer<typeof DesignReviewConfigSchema>;
