# Apature Gate - Actionable Backlog

Created: 2026-06-16
Status: build-order map for GitHub issues

## 1. How To Use This Backlog

Gate has 54 open issues across five milestones. The issue set is good, but it should be worked in a narrow vertical order. Do not begin with dashboard, billing, marketplace, baseline comparison, or YC video work until the M1 Action-path review loop runs against a mock engine.

The first issue is [#30](https://github.com/apatureai/gate/issues/30).

## 2. Definition Of Ready

An issue is ready to implement when it has:

- A milestone.
- Area, type, priority, and size labels.
- Acceptance criteria.
- Explicit dependencies by issue number or repo.
- A clear owner repo boundary.
- No requirement for Gate to edit customer code or request `contents: write`.

If an issue touches `judgment-engine`, the Gate side should define the client, request, response, auth, timeout, and failure behavior. Engine internals stay in `apatureai/judgment-engine`.

## 3. M0 Foundation Order

M0 creates the runtime that every later issue assumes.

| Order | Issue | Why it is first |
|---|---|---|
| 1 | [#30 Infra: service + Action monorepo scaffold + shared types package](https://github.com/apatureai/gate/issues/30) | Creates the repo shape and shared contracts. |
| 2 | [#31 Infra: lint + typecheck + test CI pipeline](https://github.com/apatureai/gate/issues/31) | Keeps every later issue shippable. |
| 3 | [#33 Infra: Postgres provisioning + migrations](https://github.com/apatureai/gate/issues/33) | Needed for runs, installs, comments, feedback, and billing. |
| 4 | [#34 Infra: Redis provisioning](https://github.com/apatureai/gate/issues/34) | Needed for queue, current SHA, and rate limits. |
| 5 | [#35 Infra: secrets + KMS envelope](https://github.com/apatureai/gate/issues/35) | Required before preview bypass, storage state, and engine auth. |
| 6 | [#50 Security: Postgres RLS tenant isolation](https://github.com/apatureai/gate/issues/50) | Makes isolation a schema property, not an afterthought. |
| 7 | [#32 Infra: Fly.io app + deploy](https://github.com/apatureai/gate/issues/32) | Gives the service a hosted route for artifacts and App path. |
| 8 | [#36 Infra: OpenTelemetry traces + metrics](https://github.com/apatureai/gate/issues/36) | Makes stale-publish and latency measurable. |

M0 exit:

- `pnpm install`, `pnpm typecheck`, and `pnpm test` exist and pass.
- Service and Action packages compile.
- Shared types export the Gate-engine contracts.
- Local Postgres/Redis or test substitutes can run the M1 harness.

## 4. M1 Action-Path Vertical Slice

M1 proves the core product without requiring a hosted GitHub App install.

| Order | Issue | Role |
|---|---|---|
| 1 | [#27 Config: .designreview.yml schema + validation + defaults](https://github.com/apatureai/gate/issues/27) | Normalize product intent. |
| 2 | [#8 Orchestrator: preview-URL discovery - Action path](https://github.com/apatureai/gate/issues/8) | Find the rendered UI. |
| 3 | [#45 Engine: async job API contract](https://github.com/apatureai/gate/issues/45) | Avoid long-held engine requests. |
| 4 | [#37 Engine: judgment-engine client](https://github.com/apatureai/gate/issues/37) | Single Gate-to-engine boundary. |
| 5 | [#47 Auth: HMAC-signed Gate->engine requests](https://github.com/apatureai/gate/issues/47) | Prevent tenant misrouting. |
| 6 | [#39 Security: preview-URL source verification](https://github.com/apatureai/gate/issues/39) | Verify source before handoff. |
| 7 | [#46 Contract: schema version + Zod parse + golden fixture](https://github.com/apatureai/gate/issues/46) | Runtime-safe engine responses. |
| 8 | [#38 Engine: failure & degradation handling](https://github.com/apatureai/gate/issues/38) | Make failure non-destructive. |
| 9 | [#10 Delivery: sticky PR comment](https://github.com/apatureai/gate/issues/10) | Main user-facing surface. |
| 10 | [#11 Delivery: Check Run conclusion mapping](https://github.com/apatureai/gate/issues/11) | Advisory-by-default merge signal. |
| 11 | [#12 Delivery: annotated screenshots and stable routes](https://github.com/apatureai/gate/issues/12) | Makes findings obvious and durable. |
| 12 | [#22 Action: GitHub Action entrypoint](https://github.com/apatureai/gate/issues/22) | Packages the zero-infra adoption path. |
| 13 | [#40 Test: end-to-end acceptance harness](https://github.com/apatureai/gate/issues/40) | Locks the product loop. |
| 14 | [#51 Security: Action-path hostile-PR capture threat model](https://github.com/apatureai/gate/issues/51) | Documents safe use and fork limits. |

M1 exit:

- A PR with an explicit preview URL posts one sticky annotated design review and one advisory Check Run.
- The same flow works with local serve fallback.
- A blocker remains neutral unless blocking is configured.
- Engine timeout or invalid shape produces a neutral not-reviewed result.
- No path asks for `contents: write`.

## 5. M2 Hosted App Path

M2 converts the product from Action-only to hosted App.

Core order:

1. [#1 Fastify server + webhook receiver](https://github.com/apatureai/gate/issues/1)
2. [#2 GitHub App auth + HMAC webhook verify](https://github.com/apatureai/gate/issues/2)
3. [#55 deployment_status preview discovery](https://github.com/apatureai/gate/issues/55)
4. [#3 BullMQ queue](https://github.com/apatureai/gate/issues/3)
5. [#48 ReviewJobWorker interface + BullMQ adapter](https://github.com/apatureai/gate/issues/48)
6. [#4 supersession and publish guard](https://github.com/apatureai/gate/issues/4)
7. [#5 readiness-driven debounce](https://github.com/apatureai/gate/issues/5)
8. [#6 concurrency and fair scheduling](https://github.com/apatureai/gate/issues/6)
9. [#7 10-minute full-review cap](https://github.com/apatureai/gate/issues/7)
10. [#43 review-depth signaling and cap coordination](https://github.com/apatureai/gate/issues/43)
11. [#49 webhook dedup + GitHub rate-limit backoff](https://github.com/apatureai/gate/issues/49)
12. [#9 Vercel Protection bypass + deployment filtering](https://github.com/apatureai/gate/issues/9)
13. [#21 minimal GitHub App permissions](https://github.com/apatureai/gate/issues/21)
14. [#13 POST-only feedback endpoints](https://github.com/apatureai/gate/issues/13)
15. [#41 feedback event model](https://github.com/apatureai/gate/issues/41)
16. [#23 hosted GitHub App product surface](https://github.com/apatureai/gate/issues/23)
17. [#28 auth storageState wizard](https://github.com/apatureai/gate/issues/28)
18. [#52 tenant offboarding + crypto-shredding](https://github.com/apatureai/gate/issues/52)

M2 exit:

- Hosted GitHub App reviews PR preview deployments from deployment-status events.
- Rapid pushes cannot publish stale comments.
- Feedback events flow to the shared store.
- Minimal permissions are documented and enforced.

## 6. Later Milestones

M3 Hosted tier:

- Dashboard shell, run history, config UI, feedback stats, billing, enterprise routing.
- Do not start before M2 produces durable run data.

M4 Trust polish:

- Baseline comparison, marketplace listing, YC demo automation, public launch artifacts.
- Marketplace paperwork can start early, but product claims should wait for M1 proof.

## 7. Backlog Gaps To Watch

No new issue is required today, but these should stay visible:

- Gate depends on `judgment-engine` fixtures and API behavior; cross-repo contract tests should be added when both repos have code.
- `ui-graph` can later reduce prompt cost and improve element grounding, but it is not required for Gate M1.
- Baseline comparison is powerful, but it should not delay the first rendered-UI judgment loop.
