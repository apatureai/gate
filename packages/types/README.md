# @gate/types

The single source of truth for Gate's engine-boundary contracts:
`GateReviewRequest`, `GateReviewResult`, `Finding`, `NormalizedDesignReviewConfig`,
`ReviewDepth`, `FeedbackEvent`. Engine-neutral — no model-specific fields (the
default judge is Qwen3-VL through `judgment-engine`; nothing here hard-codes
Claude).

## Schema evolution rule: additive-only

`GateReviewRequest` and `GateReviewResult` evolve **additive-only within a major
schema version** (current major: `1`, see `SCHEMA_VERSION` in `@gate/engine`).
Two repos deploy independently (Gate and judgment-engine), so the contract must
never break across a deploy skew. Concretely:

- **Allowed (no major bump):** add a new optional field; widen a union with a new
  member the consumer already tolerates; add a new metadata field.
- **NOT allowed (requires a major bump + coordinated rollout):** remove or rename
  a field; change a field's type; make an optional field required; narrow a union.

Enforcement:

- The engine response carries an `x-schema-version` header. Gate validates the
  **major** version, then Zod-parses `GateReviewResult` (`@gate/engine`
  `parseEngineResult`). A version or shape mismatch is a typed error that blocks
  publish — never a silent null-grade comment.
- The golden fixture `fixtures/gate-review-result.golden.json` is the shared
  contract artifact: Gate's mock/e2e and the engine's serializer test (cross-repo)
  both consume it, so the mock cannot drift from the live contract.
- Gate pins the fixture's Judgment Engine Git blob in the fixture test. Updating
  the cross-repo contract requires copying the authoritative engine fixture byte
  for byte and deliberately updating that pin.

Result-level and per-finding `confidence` are optional only for historical
results. Judgment Engine owns calibration and aggregation; Gate preserves valid
values in `[0, 1]` and never computes a fallback. Current PR rendering omits the
number, while storage/dashboard loaders retain it for audit and future trust UX.

The Zod schema deliberately strips unknown fields (no `.strict()`), so an older
Gate tolerates new additive fields from a newer engine.
