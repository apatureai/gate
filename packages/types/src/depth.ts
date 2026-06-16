/**
 * Review depth signaling (TRD §6, §15.1).
 *
 * `triage` is the fast path used when a PR pushes inside the 10-minute
 * full-review window; `deep` is the full review. Gate sends this to the engine
 * and the engine honors the 10-minute cap accordingly (#43).
 */
export type ReviewDepth = "triage" | "deep";
