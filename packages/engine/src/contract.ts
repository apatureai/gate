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
/**
 * What the run actually looked at (verdict#165).
 *
 * Named in the schema for the same reason `provenance` is: the schema is
 * deliberately not `.strict()`, so anything it does not name is STRIPPED, and a
 * coverage field that never survives parsing cannot stop a green Check Run from
 * being published over a review that touched nothing.
 *
 * Every member is required WITHIN the object even though the object itself is
 * optional. Half-stated coverage is not a weaker claim, it is an unreadable one:
 * `routesReviewed` without `routesRequested` cannot tell partial from full.
 * Omitting the object entirely is the supported way to say nothing.
 */
const coverageSchema = z.object({
  routesRequested: z.array(z.string()),
  routesReviewed: z.array(z.string()),
  viewportsRequested: z.array(z.enum(["mobile", "tablet", "desktop"])),
  viewportsReviewed: z.array(z.enum(["mobile", "tablet", "desktop"])),
});

/**
 * The measured half of the review (verdict `MeasurementReport`).
 *
 * Named here for the same reason `coverage` and `provenance` are, and with a
 * sharper consequence than either. This schema is deliberately not `.strict()`,
 * so a field it does not name is STRIPPED: silently, with no error and no log
 * line. Gate has been publishing "The capture and the measured facts are real"
 * into a live Check Run summary while holding no measured fact and having no
 * field one could ever have arrived in. That sentence becomes true the moment
 * this object parses, and was false every line before it.
 *
 * `blockEligible` is the ENGINE's precision claim, not Gate's policy. Gate never
 * computes it and never overrides it; it only refuses to let a `false` one
 * change a Check Run conclusion.
 *
 * `severity` is the engine's ordinal band for the same violation, and it is
 * named here for the reason everything else in this file is named here: a field
 * this schema does not name is STRIPPED, silently, and a band that never
 * survives parsing cannot tell a contrast ratio that fell from 2.91:1 to 1.02:1
 * apart from one that did not move at all.
 *
 * Deliberately NOT range-checked into a parse failure. A band Gate cannot read
 * degrades to absent, absent means unknown, and unknown never gates, so the
 * worst a bad value can do is switch this comparison off. Refusing the parse
 * instead would turn a future engine's fourth band into a blocked publish, which
 * is the strictly worse of the two errors and the one this file already refuses
 * elsewhere (`source` is `catch`-guarded for the same reason). `.int()` and
 * `.positive()` are there so a magnitude that leaked into the field, `2.91` or
 * `-1`, reads as unknown rather than as a band.
 *
 * Required WITHIN the object, optional as a whole, exactly like `coverage`:
 * `violations` without `checksRun` cannot tell "measured, clean" from "not
 * measured", and omitting the object is the supported way to say nothing.
 */
const measurementKindEnum = z.enum(["contrast", "overflow", "touch_target"]);

const measurementsSchema = z.object({
  checksRun: z.array(measurementKindEnum),
  violations: z.array(
    z.object({
      kind: measurementKindEnum,
      route: z.string(),
      viewports: z.array(z.enum(["mobile", "tablet", "desktop"])),
      element: z.string(),
      detail: z.string(),
      blockEligible: z.boolean(),
      severity: z.number().int().positive().optional().catch(undefined),
    }),
  ),
});

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
  hallucinationDrops: z.number().int().nonnegative().optional(),
  // The engine retracting its own grade. Left open rather than enumerated:
  // an unrecognized reason still means the grade is not usable, and a
  // consumer that rejected an unknown value would turn an honest engine
  // into a parse failure.
  gradeUnavailableReason: z.string().min(1).optional(),
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
  // Additive engine field (verdict#165). Preserved through parsing; the Check
  // Run refuses to publish a grade when it says nothing was reviewed.
  coverage: coverageSchema.optional(),
  // Additive engine field. Preserved through parsing; rendered inside the
  // existing "Apature Gate" check and NEVER allowed to change the conclusion
  // unless a repo explicitly opts in with `rules.measurements: block`.
  measurements: measurementsSchema.optional(),
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
