# @gate/types

The single source of truth for Gate's engine-boundary contracts:
`GateReviewRequest`, `GateReviewResult`, `Finding`, `NormalizedDesignReviewConfig`,
`ReviewDepth`, `FeedbackEvent`. Engine-neutral, with no model-specific fields (the
default judge is Qwen3-VL through `verdict`; nothing here hard-codes
Claude).

## Schema evolution rule: additive-only

`GateReviewRequest` and `GateReviewResult` evolve **additive-only within a major
schema version** (current major: `1`, see `SCHEMA_VERSION` in `@gate/engine`).
Two repos deploy independently (Gate and verdict), so the contract must
never break across a deploy skew. Concretely:

- **Allowed (no major bump):** add a new optional field; widen a union with a new
  member the consumer already tolerates; add a new metadata field.
- **NOT allowed (requires a major bump + coordinated rollout):** remove or rename
  a field; change a field's type; make an optional field required; narrow a union.

Enforcement:

- The engine response carries an `x-schema-version` header. Gate validates the
  **major** version, then Zod-parses `GateReviewResult` (`@gate/engine`
  `parseEngineResult`). A version or shape mismatch is a typed error that blocks
  publish, never a silent null-grade comment.
- The golden fixture `fixtures/gate-review-result.golden.json` is the shared
  contract artifact: Gate's mock/e2e and the engine's serializer test (cross-repo)
  both consume it, so the mock cannot drift from the live contract.
- Gate pins the fixture's Verdict Git blob in the fixture test. Updating
  the cross-repo contract requires copying the authoritative engine fixture byte
  for byte and deliberately updating that pin.

Result-level and per-finding `confidence` are authoritative only when the result
carries a valid content-addressed `calibration` reference. Verdict owns
calibration, aggregation, thresholds, and blocking promotion; Gate preserves
those additive fields and never computes a fallback. Historical pre-report
results (including ones with numeric fields) remain parseable for storage and
audit, but `hasDisplayableConfidence` returns false, so consumers must hide the
number and must not use it for gating. The authoritative golden and historical
negative fixture are copied byte-for-byte from Verdict and pinned by Git
blob id to make deploy skew explicit.

The Zod schema deliberately strips unknown fields (no `.strict()`), so an older
Gate tolerates new additive fields from a newer engine.
