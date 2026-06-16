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
- [ ] #35 - Infra: secrets + KMS envelope for gate-held secrets
- [ ] #50 - Security: Postgres RLS tenant isolation + isolation test suite
- [ ] #32 - Infra: Fly.io app + deploy for the App/orchestrator service
- [ ] #36 - Infra: OpenTelemetry traces + metrics + dashboards/alerts (stale-publish=0)

## M1 · Action path

- [ ] #27 - Config: .designreview.yml schema + validation + defaults
- [ ] #8 - Orchestrator: preview-URL discovery - Action path (explicit + url_template + provider-bot + local-serve)
- [ ] #45 - Engine: async job API contract (POST/GET/DELETE /jobs, idempotency, poll/cancel)
- [ ] #37 - Engine: judgment-engine client (GateReviewRequest -> GateReviewResult)
- [ ] #47 - Auth: HMAC-signed Gate->engine requests scoped to installationId
- [ ] #39 - Security: preview-URL source verification before engine handoff
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
