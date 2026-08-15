import type { GateReviewResult } from "@gate/types";
import { z } from "zod";

/**
 * Runtime contract safety for the engine response (TRD §6, §14, §15.2).
 *
 * TS types are erased at runtime, so a renamed/removed engine field would parse
 * into a silent null-grade review without firing the stale-publish alarm. Gate
 * validates `x-schema-version` (major) and Zod-parses `GateReviewResult`; any
 * mismatch is a typed error that blocks publish, never a null-grade comment.
 *
 * Versioning follows Stripe/GitHub: additive-only within a major version. The
 * schema intentionally does NOT use `.strict()`, so new additive engine fields
 * are tolerated (stripped) by an older Gate.
 */
export const SCHEMA_VERSION = "1";
const confidenceSchema = z.number().finite().min(0).max(1);
const calibrationSchema = z.object({
  reportId: z.string().min(1),
  reportHash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .transform((hash) => hash as `sha256:${string}`),
  calibrationVersion: z.string().min(1),
  confidenceSource: z.enum([
    "raw_verbalized",
    "post_hoc_isotonic",
    "post_hoc_histogram",
    "hidden_state_probe",
    "ensemble",
  ]),
});

const findingSchema = z.object({
  id: z.string(),
  // Additive engine field (verdict#159): preserved through parsing so
  // downstream consumers keep the rubric dimension; Gate never synthesizes it.
  dimension: z
    .enum(["visual_hierarchy", "spacing", "color_contrast", "typography", "consistency", "responsiveness", "accessibility", "brand"])
    .optional(),
  severity: z.enum(["nit", "minor", "major", "blocker"]),
  title: z.string(),
  description: z.string(),
  route: z.string(),
  viewport: z.enum(["mobile", "tablet", "desktop"]),
  element: z.string().nullable(),
  screenshotId: z.string().nullable(),
  suggestion: z.string().nullable(),
  confidence: confidenceSchema.optional(),
});

/**
 * The engine's judgment provenance (verdict `packages/types/src/provenance.ts`).
 *
 * This has to be named in the schema, not merely in the TS type: the schema is
 * deliberately not `.strict()`, so anything it does not name is STRIPPED. Before
 * this field existed, verdict's `model_backed: false` stamp was parsed off the
 * payload and thrown away, and Gate published the accompanying `grade: "ship"`
 * as a green Check Run: exactly the claim the stamp exists to prevent.
 *
 * `source` is `catch`-guarded so a future engine value degrades to `unknown`
 * instead of failing the whole parse and blocking publish. `model_backed` stays
 * strict, because it is the field the publish decision turns on and a value Gate
 * cannot read must never be guessed.
 */
const provenanceSchema = z.object({
  model_backed: z.union([z.boolean(), z.null()]),
  source: z.enum(["model", "canned", "fixture", "unknown"]).catch("unknown"),
  engine: z.string(),
  model: z.string().nullable(),
  detail: z.string(),
});

export const GateReviewResultSchema = z.object({
  grade: z.enum(["ship", "ship_with_nits", "needs_work", "blocked"]),
  overall: z.string(),
  confidence: confidenceSchema.optional(),
  calibration: calibrationSchema.optional(),
  blockingEnabled: z.boolean().optional(),
  confidenceUnavailableReason: z
    .enum([
      "missing_calibration_report",
      "invalid_calibration_report",
      "mismatched_calibration_report",
      "insufficient_evidence",
      "unattested_calibration_report",
    ])
    .optional(),
  findings: z.array(findingSchema),
  notReviewed: z.array(z.string()),
  artifacts: z.object({
    annotatedScreenshots: z.array(z.object({ findingId: z.string(), url: z.string() })),
    engineDebugUrl: z.string().optional(),
    // Additive engine field (Verdict #20). Preserved through parsing;
    // rendered as an informational capture-health caveat, never a finding.
    pageHealthFootnote: z.string().optional(),
  }),
  screenshotRetentionSeconds: z.number(),
  metadata: z.object({
    engineVersion: z.string(),
    model: z.string(),
    promptVersion: z.string(),
    captureVersion: z.string(),
    rubricVersion: z.string().optional(),
    uiDnaVersion: z.string().nullable(),
  }),
  provenance: provenanceSchema.optional(),
});

// Compile-time guarantee that the schema output IS GateReviewResult.
type SchemaOutput = z.infer<typeof GateReviewResultSchema>;
const _typeCheck: (x: SchemaOutput) => GateReviewResult = (x) => x;
void _typeCheck;

export type ParseEngineResult =
  | { ok: true; result: GateReviewResult }
  | { ok: false; reason: "schema_version_mismatch"; detail: string }
  | { ok: false; reason: "schema_parse_error"; issues: string[] };

/** Extract the major component of a version string ("1.4.2" -> "1"). */
export function majorVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  return version.split(".")[0] ?? null;
}

/**
 * Validate the `x-schema-version` major and Zod-parse the engine response body.
 * On version mismatch Gate degrades gracefully (caller posts neutral); on a
 * shape mismatch Gate blocks publish with a typed error rather than a null grade.
 */
export function parseEngineResult(
  body: unknown,
  schemaVersionHeader: string | null | undefined,
): ParseEngineResult {
  const major = majorVersion(schemaVersionHeader);
  if (major === null) {
    return { ok: false, reason: "schema_version_mismatch", detail: "missing x-schema-version header" };
  }
  if (major !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "schema_version_mismatch",
      detail: `unsupported schema version ${schemaVersionHeader} (Gate supports major ${SCHEMA_VERSION})`,
    };
  }
  const parsed = GateReviewResultSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema_parse_error",
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, result: parsed.data };
}
