# Deferred hardening (scale-tier)

Spec: TRD §15; ARCHITECTURE §8 decision log. From the 2026-06-15 architecture
review. **None of these are MVP** — each has a named trigger and is kept explicit
so the enterprise path isn't forgotten. Split into its own issue when its trigger
fires.

Hard invariants that hold across **every** migration below: Gate is
judgment-only (no `contents: write`), the supersession identity (`repo#pr`) and
durable completed-review identity `(repo_owner, repo_name, pr_number, head_sha)`,
the versioned repository-scoped Judgment Engine intent key, the publish-time
identity guard, the publish-time SHA guard, and
`stale_publish_rate = 0`.

## D0 — Engine idempotency conflict request-digest validation

- **Today:** Gate #184 domain-separates its caller key as `gate-review-v2` over
  the canonical repository/PR/head identity and refuses a mismatched
  client-outcome identity before publication.
- **Migration:** Judgment Engine [#178](https://github.com/apatureai/judgment-engine/issues/178)
  persists its own canonical immutable-request digest and rejects a key conflict
  when that digest differs, without returning the existing job id. The caller
  intent hash stays opaque and tenant-bound.
- **Trigger:** implement before accepting a second independently deployed
  caller-key implementation or enabling blocking mode in production.

## D1 — Engine invocation: completion-webhook callback (replaces polling)

- **Today:** Gate submits a job and polls with depth-aware backoff (#45), capped
  at the 10-minute deadline.
- **Migration:** the engine calls back a Gate webhook on completion instead of
  Gate polling.
- **Trigger:** poll volume/latency warrants it (poll cost or first-comment
  latency regresses at scale).

## D4 — Contract: Pact consumer-driven contract tests

- **Today:** a shared golden fixture + `x-schema-version` + Zod runtime parse
  (#46) keep the two repos from drifting.
- **Migration:** Pact consumer-driven contracts with engine-CI provider
  verification.
- **Trigger:** the engine deploys independently of Gate on its own cadence.

## D4 — Auth: short-lived JWT + JWKS (replaces HMAC)

- **Today:** HMAC-SHA256 request signing scoped to `installationId` (#47).
- **Migration:** short-lived JWT + a JWKS endpoint.
- **Trigger:** multiple independent services call the engine (not just Gate),
  making a shared HMAC secret unwieldy.

## D2 — Durability: migrate ReviewJobWorker to Inngest singleton-cancel

- **Today:** BullMQ behind the `ReviewJobWorker` interface; cooperative
  cancellation (AbortSignal) + the publish-time guard (#48, #4). See
  docs/queue-migration-inngest.md.
- **Migration:** Inngest `singleton: { key: "repo#pr", mode: "cancel" }` makes
  supersession structural.
- **Trigger:** stale-publish rate non-zero for two consecutive weeks.

## D5 — Delivery: transactional outbox + REST reconciliation sweep

- **Today:** at-least-once webhook dedup on `X-GitHub-Delivery` + rate-limit
  backoff (#49); sticky comment + Check Run are the delivery surface.
- **Migration:** a transactional outbox plus a periodic REST reconciliation
  sweep to cover the crash window between a GitHub write and the Postgres commit.
- **Trigger:** observed crash-window inconsistency (a delivered review missing
  its DB record, or vice versa).
