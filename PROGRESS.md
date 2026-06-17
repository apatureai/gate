# Apature Gate - Build Progress (loop source of truth)

This file is the deterministic checklist for the autonomous build loop. Work top-down.

How the loop uses it:
- Pick the FIRST unchecked `[ ]` issue whose dependencies are already `[x]`.
- When done (code + tests green, pushed): change `[ ]` to `[x]` and append ` -> done: <one line>`.
- If blocked, mark `[~]` and append ` -> skipped: <reason>`, then take the next unblocked issue.
- Build order is M0 -> M1 -> M2 -> M3 -> M4. Cross-repo deps tagged [judgment-engine #N] are MOCKED, not built here.


## M0 · Foundation & runtime

- [x] #30 - Infra: service + Action monorepo scaffold + shared types package -> done: pnpm workspace (types/service/action) + tsc -b project refs; @gate/types exports the engine boundary contracts (§6 + §15.2 amendments) and the shared golden fixture loader; service/action consume them; no contents:write; typecheck+test(12)+lint green
- [x] #31 - Infra: lint + typecheck + test CI pipeline -> done: .github/workflows/ci.yml runs pnpm install --frozen-lockfile + lint + tsc -b + tests on every PR/push; lint is warnings-as-errors (eslint --max-warnings=0); typecheck covers all packages via project refs. NOTE: marking the check "required before merge" is a one-time branch-protection setting for a maintainer (needs admin; left for human).
- [x] #33 - Infra: Postgres provisioning + migrations (installations, runs, feedback_events, billing) -> done: packages/db with idempotent migration runner (schema_migrations tracking) + 0001_init.sql (installations, runs w/ UNIQUE(pr,head_sha)+last_full_review_at+expires_at, feedback_events, billing_customers, webhook_log); pg adapter for deploy + PGlite-backed tests in CI; migrate CLI for Fly release cmd (wired in #32). NOTE: real Neon/Fly provisioning is an ops step.
- [x] #34 - Infra: Redis provisioning (BullMQ + current_sha + per-installation token-bucket) -> done: packages/redis with resilient ioredis client (maxRetriesPerRequest:null + capped retryStrategy, no silent drops), bull:/sha:/tb:/cb: namespaces + key builders (supersessionKey, tokenBucketKey, cb:engine), and assertNoEviction() guard enforcing noeviction so sha: keys are never dropped. NOTE: real Upstash/Fly Redis provisioning is an ops step.
- [x] #35 - Infra: secrets + KMS envelope for gate-held secrets -> done: packages/secrets with SecretStore (app secrets incl. engineEndpoint) + EnvSecretStore dev seam; AES-256-GCM envelope (sealSecret/openSecret) wrapping a per-repo DEK under a CMK (shared/per-tenant, never per-repo KMS keys), GCM integrity-checked; redact() scrubs secrets/signed-URLs/storageState/screenshot data from logs; storageStateForPr/assertStorageStateAllowed disable storageState on fork PRs. NOTE: bind SecretStore/KmsKeyProvider to real AWS KMS in ops.
- [x] #50 - Security: Postgres RLS tenant isolation + isolation test suite -> done: 0002_rls.sql ENABLE+FORCE RLS with installation_id-scoped USING/WITH CHECK policies on installations/runs/feedback_events/billing_customers (default-deny when GUC unset); withTenant() sets app.current_installation_id per transaction via set_config; isolation suite (run under a non-superuser role since pglite superuser bypasses RLS) proves cross-tenant read/update/insert are denied + default-deny. CI runs it.
- [x] #32 - Infra: Fly.io app + deploy for the App/orchestrator service -> done: minimal Fastify server (buildServer) with /healthz (#1 extends it); Dockerfile (multi-stage, prune --prod, no secrets in image) + .dockerignore; fly.toml deploys to Fly Machines with a /healthz http check, release_command running db migrations, min 1 machine; .github/workflows/deploy.yml runs flyctl deploy on merge to main (FLY_API_TOKEN). NOTE: creating the Fly app + setting fly secrets are ops steps.
- [x] #36 - Infra: OpenTelemetry traces + metrics + dashboards/alerts (stale-publish=0) -> done: packages/observability with SPAN_NAMES taxonomy (webhook->preview->enqueue->engine->guard->publish) + withSpan helper; GateMetrics (stale_publish counter [must be 0], review/time-to-first-comment latency, queue_depth gauge, engine errors/submit-latency/poll-count/cancels/timeouts, capture instability); initTelemetry wires OTel providers (exporters injected/OTEL_* env). observability/alerts.yaml fires on stale_publish>0 + SLO alerts; observability/dashboard.json panels for latency/queue depth/engine errors. Tested via OTel in-memory exporters.

## M1 · Action path

- [x] #27 - Config: .designreview.yml schema + validation + defaults -> done: packages/config with a Zod schema covering preview/routes/viewports/dark_mode/brand/rules/tokens (.strict() catches typos); every field has a working default so the file is optional; loadDesignReviewConfig parses YAML + normalizes snake_case -> NormalizedDesignReviewConfig (added tokens to @gate/types); ConfigValidationError surfaces readable issues (incl. YAML syntax). Shared schema export for extractor + dashboard.
- [x] #8 - Orchestrator: preview-URL discovery - Action path (explicit + url_template + provider-bot + local-serve) -> done: resolvePreviewUrl() in @gate/action resolves explicit -> url_template ({pr}/{sha}/{short_sha}) -> allowlisted provider-bot comment (gated on config.preview.source naming a known provider + bot-login allowlist + domain-suffix match, so free-text comments are never trusted) -> local-serve (preview-command); returns url + source + provider + provenance, or a reason listing attempts.
- [x] #45 - Engine: async job API contract (POST/GET/DELETE /jobs, idempotency, poll/cancel) -> done: packages/engine job protocol — idempotencyKey(pr:headSha), depth-aware backoff (triage 10s+/deep 30s+, then +10s) capped at the 10-min REVIEW_DEADLINE_MS; runEngineJob submits then polls (409 polls existing job, no re-capture); timeout returns review_timed_out with no retry; cancelEngineJob best-effort; fetch-based HTTP transport behind a seam (HMAC #47 / zod parse #46 layer on later). NOTE: #45's stated dep on #37 is inverted — the contract precedes the client; #37 will build on this.
- [x] #37 - Engine: judgment-engine client (GateReviewRequest -> GateReviewResult) -> done: createJudgmentEngineClient in @gate/engine — buildGateReviewRequest assembles the request from preview+config+PR context; review() submits via the #45 job protocol (idempotent per pr:headSha) with bounded submit retry + backoff and polls to a GateReviewResult; extractReviewMetadata surfaces engineVersion/model/promptVersion/captureVersion/uiDnaVersion (model is engine-selected, never Claude). Auth+timeout in the transport; #46 (zod parse) / #47 (HMAC) layer on next.
- [x] #47 - Auth: HMAC-signed Gate->engine requests scoped to installationId -> done: signEngineRequest/verifyEngineRequest (HMAC-SHA256 over `${ts}.${installationId}.${body}`, constant-time compare, optional skew window) in @gate/engine; HTTP transport signs the submit body when hmacSecret set (installationId bound in headers) so the engine verifies + scopes storage to the verified tenant; secret sourced from @gate/secrets engineHmacSecret (KMS). Verifier returns typed reasons for caller logging/alert. Engine-side verify+alert is cross-repo (mocked).
- [x] #39 - Security: preview-URL source verification before engine handoff -> done: verifyPreviewHandoff in @gate/engine independently re-checks provenance at the boundary — forwards only verified origins (deployment_status/explicit/url_template/provider-bot/local), enforces per-provider domain match (loopback for local, any http(s) for explicit), returns not_reviewed: unverified_preview_source for free-text/mismatched URLs, and disables bypass+storageState secrets on fork PRs (via @gate/secrets). Engine still owns SSRF/DNS-rebind.
- [ ] #46 - Contract: x-schema-version header + Zod runtime parse + golden fixture
- [ ] #38 - Engine: failure & degradation handling
- [ ] #10 - CI: sticky PR comment (hidden marker + optimistic node_id)
- [ ] #11 - CI: Check Run conclusion mapping (default non-blocking)
- [ ] #12 - CI: annotated screenshots (sharp from geometry) + stable /i/<id>.png -> 302 signed URL
- [ ] #22 - Action: GitHub Action entrypoint (action.yml + Docker, runner capture)
- [ ] #40 - Test: end-to-end acceptance harness (TRD §11)
- [ ] #51 - Security: Action-path hostile-PR capture threat model

## M2 · App path

- [ ] #1 - Orchestrator: Fastify server + webhook receiver
- [ ] #2 - Orchestrator: GitHub App auth + HMAC webhook verify
- [ ] #55 - Orchestrator: deployment_status preview discovery (webhook -> SHA match -> dedupe)
- [ ] #3 - Orchestrator: BullMQ queue (key repo#pr, completed-id pr+head_sha)
- [ ] #48 - Orchestrator: ReviewJobWorker interface + BullMQ adapter (Inngest migration path)
- [ ] #4 - Orchestrator: supersession (current_sha + AbortController + publish-time guard)
- [ ] #5 - Orchestrator: readiness-driven debounce (120s ceiling) + wait_seconds floor
- [ ] #6 - Orchestrator: concurrency (repo,pr)=1 + per-installation fair scheduling
- [ ] #7 - Orchestrator: 10-min full-review cap -> triage-only
- [ ] #43 - Engine: review-depth signaling (triage vs deep) + 10-min-cap coordination
- [ ] #49 - Orchestrator: webhook delivery dedup + GitHub secondary-rate-limit backoff
- [ ] #9 - Orchestrator: Vercel Protection bypass + multi-deployment filtering
- [ ] #21 - Security: minimal GitHub App permissions (never contents:write)
- [ ] #13 - CI: feedback signal endpoints — POST-only (reaction API / slash command + HMAC)
- [ ] #41 - Data: feedback event model + forward to shared store
- [ ] #23 - App: hosted GitHub App install path
- [ ] #28 - Config: npx designreview auth storageState wizard
- [ ] #52 - Data: tenant offboarding + crypto-shredding pipeline

## M3 · Hosted tier

- [ ] #15 - Dashboard: Next.js shell + auth
- [ ] #16 - Dashboard: run history + finding browser
- [ ] #17 - Dashboard: feedback stats
- [ ] #18 - Dashboard: config UI (.designreview.yml editor + validate)
- [ ] #19 - Billing: Stripe subscriptions + free-tier limits
- [ ] #20 - Billing: enterprise SSO + in-VPC residency option
- [ ] #29 - Config: onboarding flow (brand block, protection_bypass, preview source)
- [ ] #53 - Enterprise: in-VPC judgment-engine endpoint (per-account engineEndpoint, no-fallback)
- [ ] #54 - Hardening (deferred, M3): webhook callback / Pact / JWT / Inngest / outbox

## M4 · Trust polish

- [ ] #14 - CI: baseline comparison v1.5 (before/after pairs)
- [ ] #24 - GTM: GitHub Marketplace listing + verification (start week 1)
- [ ] #25 - GTM: launch demo — agent-breaks-the-design-system caught in 90s
- [ ] #26 - GTM: public-judgment-on-OSS content engine
- [ ] #42 - Test/GTM: YC demo golden-path repo + automated <90s review check
