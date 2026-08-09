# Apature Gate - Technical Requirements Document

Created: 2026-06-15
Status: MVP build specification

## 1. Technical Summary

Gate is the GitHub delivery product for Apature. It receives PR and deployment events, discovers a preview URL, coordinates one review per current PR head SHA, calls `judgment-engine`, and publishes one sticky PR comment plus one Check Run.

Gate is not the critique engine. Its job is orchestration, GitHub UX, configuration, product packaging, and delivery correctness.

Primary dependency:

```ts
critique(images, context) -> Findings
```

`judgment-engine` owns capture, context extraction, Qwen3-VL model calls, validation, eval, and shared feedback primitives. Gate owns when to call it and how to publish results.

Concrete transport:

- Gate submits review work through the async engine job API in §15.1.
- `critique(images, context) -> Findings` remains the conceptual boundary.
- Gate never holds a long request open waiting for a full review.

## 2. External Surfaces

### GitHub Action

Purpose:

- Zero-infra adoption.
- Free/public tier.
- Local-serve fallback for repos without preview deploys.

Minimum inputs:

```yaml
preview-url: null
preview-command: null
config-path: .designreview.yml
gate-mode: advisory
```

Behavior:

- If `preview-url` is provided, review that URL.
- If no URL is provided and `preview-command` exists, run the command, wait for localhost readiness, then review localhost.
- The Action path can run capture inside the user's runner, but still calls the hosted critique API unless configured otherwise.

### GitHub App

Purpose:

- Hosted paid tier.
- Webhook-driven reviews.
- Persistent feedback memory and dashboard.

Minimum permissions:

- `checks: write`
- `pull_requests: write`
- `contents: read`
- `deployments: read`

Forbidden permission:

- `contents: write`

The no-write permission boundary is a product requirement, not just a security preference.

### PR Comment

Behavior:

- One sticky comment per PR.
- Locate by hidden HTML marker.
- Update in place.
- Include grade, summary, blockers, should-fix findings, nits, not-reviewed routes, and annotated screenshot links.
- Feedback actions must not mutate state on GET.

### Check Run

Name:

```text
design-review
```

Conclusion mapping:

- `ship` -> success.
- `ship_with_nits` -> success.
- `needs_work` -> neutral.
- `blocked` -> neutral by default, failure only when repo config opts into blocking.

## 3. Configuration

Gate reads `.designreview.yml` from the repo root when available.

Minimum supported shape:

```yaml
preview:
  source: vercel
  environment: Preview
  url_template: null
  wait_seconds: 0
  ready_selector: null
  protection_bypass: null
  auth: null

routes:
  always: ["/"]
  max_per_pr: 5
  map: {}

viewports: [mobile, desktop]
dark_mode: false

brand: |
  Product description, audience, tone, and design rules.

rules:
  gate: none
  min_severity_to_comment: nit
  suppress: []
```

Defaults:

- Missing config is valid.
- Default gate mode is `none`.
- Default viewports are mobile and desktop.
- Default route is `/` when route inference cannot find a stronger candidate.

Gate validates config and passes normalized values to `judgment-engine`; it does not implement design-token extraction itself.

## 4. Preview URL Discovery

Resolution order:

1. GitHub deployment status with `state == success`.
2. Explicit Action input.
3. Configured `preview.url_template`.
4. Known provider bot comment scrape, only when provider identity and domain rules are configured.
5. Action local-serve fallback.

Deployment status requirements:

- Match deployment SHA to PR head SHA.
- Match configured environment name, default `Preview`.
- Ignore Storybook or non-app deployment environments unless configured.
- Dedupe on `(sha, deployment_id)`.

Protected preview support:

- Vercel bypass uses the configured `protection_bypass` secret name.
- Secrets are never logged.
- Auth state is disabled for fork PRs.

## 5. Queue And Supersession

Gate must be correct under rapid AI-generated push bursts.

Definitions:

- Supersession key: `repo#pr`.
- Durable completed-review identity: `(repo_owner, repo_name, pr_number, head_sha)`.
- Judgment Engine intent key: `gate-review-v2:sha256:<digest>`, where the digest
  is SHA-256 over the canonical JSON tuple `[namespace, lowercase_owner,
  lowercase_name, pr_number, lowercase_full_head_sha]`.

Required behavior:

- On enqueue, write `current_sha[repo#pr] = head_sha`.
- If a newer push arrives, signal cancellation for any active older job where possible.
- Every stage checks whether its job SHA still matches the current SHA before doing expensive work.
- Before publishing a comment or Check Run, re-read the current SHA and discard stale results.
- Use optimistic comment update behavior so older writers cannot overwrite newer comments.

Rate limits:

- At most one full review per PR per 10 minutes.
- Pushes inside the full-review window may run triage-only.
- Per `(repo, pr)` concurrency is 1.
- Per installation concurrency is tier-based and fair-scheduled.

## 6. Gate-To-Engine Request

Gate calls the shared engine with normalized product intent and GitHub context.

Minimum request fields:

```ts
type GateReviewRequest = {
  installationId: string;
  repository: {
    owner: string;
    name: string;
    defaultBranch: string;
  };
  pullRequest: {
    number: number;
    headSha: string;
    baseSha: string;
    title: string;
    body: string | null;
  };
  preview: {
    url: string;
    provider: "vercel" | "netlify" | "cloudflare" | "render" | "explicit" | "local";
    environment: string | null;
  };
  config: NormalizedDesignReviewConfig;
  publishMode: "advisory" | "blocking";
  depth: "triage" | "deep";
};
```

Minimum response fields:

```ts
type GateReviewResult = {
  grade: "ship" | "ship_with_nits" | "needs_work" | "blocked";
  overall: string;
  findings: Finding[];
  notReviewed: string[];
  artifacts: {
    annotatedScreenshots: Array<{ findingId: string; url: string }>;
    runUrl?: string;
  };
  metadata: {
    engineVersion: string;
    model: string;
    promptVersion: string;
    captureVersion: string;
    uiDnaVersion: string | null;
  };
};
```

Current model assumption:

- Qwen3-VL is the default judge through `judgment-engine`.
- Gate docs, UI, and code must not hard-code Claude as the primary model.

UI-DNA grounding (what makes the judgment repo-specific, not generic taste):

- The engine grounds each critique in the repo's UI DNA — the versioned design genome owned by `ui-dna` and represented compactly by `ui-graph`.
- Gate does not extract or store UI DNA. It passes repo identity so the engine resolves the right genome, and it version-stamps the returned `uiDnaVersion` on the run so every published finding is traceable to the genome it was judged against. `null` is valid when the repo has no extracted UI DNA yet; the engine falls back to repo context plus the brand block.

## 7. Delivery Requirements

Sticky comment:

- Always includes the reviewed commit SHA.
- Always includes a "not reviewed" section when any route, viewport, or preview was skipped.
- Annotated image links use stable app routes, not raw expiring object URLs.
- Feedback actions route to POST-backed endpoints or GitHub-native reactions/commands.

Check Run:

- Must include summary, grade, and link to the sticky comment or dashboard run.
- Must never fail by default.
- Failure requires explicit `rules.gate: blockers` or equivalent opt-in.

Dashboard handoff:

- MVP can link only to artifacts.
- Hosted tier adds run history, finding browser, config UI, and feedback stats.

## 8. Security Requirements

Gate security requirements:

- Never request `contents: write`.
- Never commit or push code.
- Never mutate feedback on GET.
- Verify GitHub webhook signatures.
- Store installation tokens securely and scope them to the installation.
- Do not log preview bypass secrets, storage state, signed URLs, or screenshot contents.
- Disable auth storage state on fork PRs.
- Pass preview URLs to `judgment-engine` only after provider/source verification.

Shared security delegated to `judgment-engine`:

- SSRF protection.
- DNS rebind checks.
- Sandbox egress policy.
- Screenshot encryption and retention.
- Prompt-injection controls.

## 9. Data And Feedback

Gate records product-facing feedback events and forwards them to the shared feedback store.

Events:

- Finding posted.
- Finding expanded or clicked when available.
- GitHub reaction or slash-command feedback.
- Ignore/suppress command.
- PR merged with unresolved blockers.
- Later diff appears to adopt a suggested token or class.

Data quality rules:

- GET requests are inert.
- Non-collaborator feedback is down-weighted by the shared data layer.
- "Touched the element" is not enough to count as implicit positive feedback.

## 10. MVP Milestones

Milestone 1: Action path

- Explicit preview URL input.
- Local serve fallback.
- Call hosted `judgment-engine`.
- Post sticky comment.
- Publish Check Run.

Milestone 2: App path

- GitHub App auth.
- Deployment status webhook handling.
- Queue, supersession, stale publish guard.
- Vercel/Netlify/Cloudflare/Render preview detection.

Milestone 3: Hosted tier

- Dashboard shell.
- Run history.
- Config UI.
- Billing and free-tier limits.
- Feedback stats.

Milestone 4: Trust polish

- Baseline comparison.
- Permanent annotated image routes.
- Marketplace listing.
- Golden-path demo repo and public launch artifacts.

## 11. Acceptance Criteria

The MVP is acceptable when:

- A PR with an explicit preview URL gets a useful annotated design review.
- A PR with a deployment status preview gets a useful annotated design review.
- Rapid pushes cannot publish stale comments.
- A blocker does not fail the Check Run unless blocking is configured.
- The app functions without `contents: write`.
- Comment feedback cannot be triggered by URL unfurlers.
- Docs and UI consistently describe Gate as judgment-only, not autofix.

## 12. Runtime And Infrastructure Substrate

Gate runs as its own service and owns its own runtime. It does not inherit `judgment-engine` infrastructure.

Monorepo (pnpm workspaces):

- `packages/types` - the engine boundary contracts (`GateReviewRequest`, `GateReviewResult`, `Finding`, `NormalizedDesignReviewConfig`). Single source of truth.
- `packages/service` - the GitHub App path: Fastify webhook receiver, BullMQ workers, publisher.
- `packages/action` - the GitHub Action entrypoint.

Hosting:

- The Fastify service runs on Fly.io Machines. The Action path runs inside the customer runner and needs no Gate-hosted compute.

State:

- Postgres holds durable product records: `installations`, `runs` (keyed for the completed-review identity `(repo_owner, repo_name, pr_number, head_sha)`), `feedback_events`, and `billing_customers`.
- Redis holds the orchestrator hot paths: `bull:` (BullMQ queue), `sha:` (`current_sha[repo#pr]` supersession), and `tb:` (per-installation token-bucket).
- Screenshots, critique JSON, and annotations live in object storage owned by `judgment-engine`. Gate stores metadata and correctness state only; queue payloads carry IDs and URLs, never large artifacts.

Secrets:

- A KMS-backed store resolves the GitHub App private key, webhook secret, `judgment-engine` API key, and Stripe keys.
- Per-repo `protection_bypass` and `storageState` are envelope-encrypted at rest, decrypted only at point of use, never logged, and disabled for fork PRs.

CI:

- Lint, typecheck, and test run on every PR and are required before merge.

## 13. Observability And SLOs

Tracing:

- OpenTelemetry spans cover the full path: webhook receive, preview resolve, enqueue, engine call, publish-time SHA guard, comment and Check Run update.

Metrics and SLOs:

- Stale-review publish rate. SLO is zero; an alert fires on any non-zero value.
- Review latency p50/p95. Target is a first annotated comment within two minutes, and under 90 seconds on the demo path.
- Queue depth and per-installation backpressure.
- Engine error rate.
- Capture-instability rate, taken from engine result metadata.
- Valid-element-reference rate after the engine's post-parse validation.

Alerts:

- Stale-publish rate above zero.
- Engine error-rate spike.
- Latency p95 breach.

## 14. Testing Strategy

- Unit tests: config normalization, preview-source verification, supersession and publish-time guard, Check Run conclusion mapping.
- Engine boundary: contract tests for `GateReviewRequest`/`GateReviewResult` against a mock `judgment-engine`, with no live model calls.
- End-to-end acceptance harness: asserts every Section 11 criterion in CI against the mock engine (explicit-URL review, deployment-status review, stale-publish guard at zero, advisory blocker stays neutral, functions without `contents: write`, feedback GET is inert).
- Demo-as-test: the golden-path repo runs as a scheduled smoke test that posts an annotated review in under 90 seconds and flips the Check Run to passing after the fix.
- Engine boundary contract test: `GateReviewResult` is validated against a Zod schema and a golden fixture (`packages/types/fixtures/gate-review-result.golden.json`). The same fixture feeds the e2e harness mock, so the mock cannot drift from the live contract.

## 15. Architecture Review Decisions (2026-06-15)

Six decisions from the architecture debate, benchmarked against enterprise practice. Each amends the sections above; each is phased (ship MVP, migrate on a named trigger). The hard invariants in ARCHITECTURE §8 survive every migration.

### 15.1 Engine invocation is asynchronous (amends §6)

Gate must not hold a connection open for a 90s+ review — the App path runs behind the Fly proxy, whose idle timeout would drop it. The seam is an async job API:

- `POST /jobs` -> `202 { jobId }`, body carries the repository-scoped,
  versioned `gate-review-v2` `idempotencyKey` defined in §5 and
  `depth: "triage" | "deep"`.
- `GET /jobs/:jobId` polled with depth-aware exponential backoff (triage first poll ~10s, deep ~30s, +10s), capped at the §5 10-minute deadline.
- `DELETE /jobs/:jobId` on supersession or when Gate abandons polling at the
  deadline (best-effort engine cancellation, signed with the verified
  installation identity).

`GateReviewRequest` gains `depth`. On a 409 (duplicate idempotency key) Gate polls
the existing job rather than re-running capture. The client binds every outcome
to the canonical review identity, and both Action and App paths assert that
identity before publication. Poll timeout first sends one bounded cancellation
request, then posts a neutral Check Run, reason `review_timed_out`, even if
cancellation fails. A terminal response racing with the DELETE is a no-op.
Deferred to scale: a completion-webhook callback replacing polling.

### 15.2 Contract safety and service-to-service auth (amends §6, §7, §8, §14)

- The engine response carries an `x-schema-version` header; Gate validates it, then Zod-parses `GateReviewResult` so a malformed result surfaces a typed error, never a silent null-grade publish. `packages/types` evolves additive-only; a golden fixture is shared by the engine serializer test and Gate's mock.
- Gate HMAC-SHA256-signs every engine request body with `installationId` in the signed payload; the engine verifies and scopes all tenant storage to that `installationId`. Deferred: Pact consumer-driven contracts + JWT/JWKS once the engine has multiple independent clients.
- `GateReviewResult.artifacts.runUrl` is removed/renamed to `engineDebugUrl` (internal). Gate constructs its own `runUrl` from the `runs` record so the PR comment never depends on engine URL structure. The result gains `screenshotRetentionSeconds`; `/i/<id>.png` serves a 410 tombstone after `receivedAt + screenshotRetentionSeconds`.

### 15.3 Orchestration durability (amends §5, §12, §13)

- BullMQ active jobs cannot be preempted; cancellation is cooperative (AbortSignal). The `AbortSignal` must be threaded into the engine HTTP client, not just the worker callback — a mandatory code-review checkpoint. The publish-time SHA guard is the correctness backstop regardless.
- The queue sits behind a `ReviewJobWorker` interface (`enqueue` / `cancel` / `onJob`) so BullMQ can be swapped for Inngest (singleton cancel mode) without rewriting orchestration. Migration trigger: stale-publish rate non-zero for two consecutive weeks.
- Redis uses `noeviction`; the `sha:` supersession key must never be evicted (eviction would let the guard read nil and pass a stale SHA). The 10-minute full-review cap is tracked durably in Postgres (`runs.last_full_review_at`), not a Redis delayed job. Debounce is abort-and-restart on the latest push, not a delay-start timer.

### 15.4 Delivery exactly-once and GitHub reliability (amends §5, §7)

- Webhooks are at-least-once: dedupe on `X-GitHub-Delivery` via a `webhook_log(delivery_id PRIMARY KEY)` insert before enqueue (duplicate -> 200 + skip). `runs` carries `UNIQUE(repo_owner, repo_name, pr_number, head_sha)`.
- The GitHub API client honors primary and secondary rate limits (`Retry-After`, `x-ratelimit-remaining`) with exponential backoff + jitter. Sticky issue-comment + Check Run remain the surface (the PR Reviews API is rejected: findings are about rendered UI, not source lines, and `REQUEST_CHANGES` is too aggressive for an advisory default). Deferred: transactional outbox + REST reconciliation sweep for missed webhooks.

### 15.5 Capture location and data residency (amends §2, §6, §8)

- Self-serve uses the hosted engine (Apature is a GDPR data processor for screenshot content; ship a DPA template). Enterprise adds a per-account `engineEndpoint` (KMS-encrypted) so Gate calls the customer's in-VPC `judgment-engine` and screenshots never leave their cloud — with no silent fallback to hosted. `engineEndpoint` is Gate-internal routing, not part of `GateReviewRequest`.
- The Action path runs hostile PR code in the capturing browser inside the customer runner; document this as an untrusted-fork threat (the App path isolates it in the engine sandbox).

### 15.6 Multi-tenancy, secrets, and SLOs (amends §8, §12, §13)

- Tenant isolation uses Postgres row-level security on `installation_id` (defense-in-depth beyond application WHERE clauses), with an isolation test suite. Installation tokens are short-lived and cached via `@octokit/auth-app` (in-process at MVP).
- Key hierarchy: shared CMK for free tier, per-tenant CMK for paid, per-repo data key (DEK) always envelope-encrypted under the tenant key — never per-repo KMS keys (cost trap at thousands of repos). `engineEndpoint` joins the KMS-managed secret set. Circuit-breaker state lives in Redis `cb:engine`.
- `stale_publish_rate = 0` is reclassified as a P1 hard invariant (incident, not just alert), not an SLO. The real SLOs: availability 99.5%; time-to-first-comment p50 90s / p95 3 min; review success rate 95%; feedback endpoint 99.9% — each with an error-budget policy. Deferred: per-tenant CMK everywhere, crypto-shred offboarding, SOC2 / EU-region.
