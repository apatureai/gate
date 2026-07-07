# Apature Gate

GitHub-native design review for AI-generated frontend PRs.

> **Applitools checks pixels. Apature checks judgment.**

---

## The idea in one paragraph

When a pull request opens, Gate finds its **preview deploy**, screenshots the rendered
UI, and asks Apature's shared **judgment engine** to critique what it sees against the
repo's design system and **UI-DNA** (its versioned design genome). It then posts exactly
**one annotated PR review** and **one GitHub Check Run** — judgment-grade feedback like
*"this CTA uses `#6c3ef0`, which isn't in your palette (closest token `primary-600`)"*,
not a diff of pixels. Gate never edits customer code, never commits a fix, and never asks
for `contents: write`. It is the company's go-to-market wedge: the pain (AI-generated UI
arriving as PRs) is already organized around GitHub, preview deploys already exist, and a
single screenshot-grounded finding makes the value obvious.

---

## Where Gate sits in the Apature ecosystem

Gate is the **buyer-facing product surface** — the first thing a customer installs and
the first revenue surface. It is deliberately **not** the whole platform. It does not own
the capture/model/eval substrate or the design genome; it *calls* them.

```
            ┌──────────────────────────────────────────────┐
            │  apatureai/gate  (THIS REPO — the product)    │
            │  delivery · orchestration · dashboard · GTM   │
            └───────────────┬──────────────────────────────┘
                            │  async job API  (GateReviewRequest)
                            │  ◄── GateReviewResult (wire contract,
                            │       anchored by a shared golden fixture)
                            ▼
            ┌──────────────────────────────────────────────┐
            │  apatureai/judgment-engine                    │
            │  browser capture · VLM critique · eval ·      │
            │  feedback substrate                           │
            └───────────────┬──────────────────────────────┘
                            │ resolves the repo's design genome
                            ▼
            ┌──────────────────────────────────────────────┐
            │  apatureai/ui-dna   (canonical design genome) │
            └──────────────────────────────────────────────┘
```

**Gate owns:** preview discovery, review orchestration + supersession, sticky PR comments,
Check Runs, the dashboard, billing, onboarding, and GTM.

**Gate does NOT own:** browser capture internals, model adapters/selection, UI-DNA
extraction/approval, or any code edits. Gate passes repo identity + a verified preview URL
to the engine; the engine resolves the right UI-DNA version and returns a grounded,
version-stamped result. The result the engine returns conforms to the **`GateReviewResult`
wire contract**, whose **golden fixture is the cross-repo anchor** shared with the engine
so both sides can't drift.

See [`ECOSYSTEM.md`](ECOSYSTEM.md) for the full product map and the other surfaces
(`pointer`, `mcp-review`, `entropy-engine`, …) that build on the same substrate later.

---

## The two execution paths

Gate ships the same judgment two ways, plus a dashboard.

### 1. Action path — `@gate/action`
A GitHub Action that runs **inside the customer's own GitHub runner**. Designed for a
**hostile-PR security model**: it is judgment-only, never requests `contents: write`, and
when it builds a preview locally it does so under an **env-allowlisted, resource-capped,
output-scrubbed** preview-command supervisor (so an attacker's PR can't exfiltrate secrets
or escape the runner). Good for teams that want self-hosted capture or no hosted install.

### 2. App path — `@gate/service`
A **hosted GitHub App** (Fastify webhook receiver → BullMQ queue → orchestrator). Reacts
to `pull_request` / `deployment_status` webhooks, discovers the preview, runs the review,
and publishes. This is the managed, zero-config-runner experience and the billing surface.

### 3. Dashboard — `@gate/dashboard` + `apps/dashboard`
`@gate/dashboard` is the tested hosted-tier **core** (OAuth, sessions, run history, finding
browser, feedback stats, config UI, billing). `apps/dashboard` is the **Next.js app-router
shell** that renders that core. The shell is standalone and built with its own Next.js
toolchain.

---

## How a review flows

```
PR / preview discovery
   (explicit URL · url_template · provider-bot comment · deployment_status · local-serve)
        │
        ▼
(optional) preview-command build + serve   ← Action path only, env-allowlisted + capped
        │
        ▼
verify the preview URL source  →  hand a verified preview URL + repo identity to the engine job
        │
        ▼
poll the engine job until done  (with the 10-min full-review cap)
        │
        ▼
post ONE sticky PR comment  +  ONE Check Run  (default advisory, opt-in blocking)
```

Two safety invariants run throughout:
- **Supersession** — a newer PR head cancels in-flight work (AbortController + a
  **publish-time SHA guard**) so Gate never posts a finding for a stale commit.
- **No customer-code writes** — Gate only ever publishes comments and checks.

---

## Key concepts / vocabulary

- **Judgment-only** — Gate critiques and verifies; it never edits code or asks for
  `contents: write`. `contents` access is read-only (config + diffs).
- **Preview discovery** — finding the deployed URL for a PR: explicit, `url_template`,
  a provider bot comment (e.g. Vercel/Netlify), the `deployment_status` webhook, or a
  locally built/served preview (Action path).
- **Engine wire contract + golden fixture** — `GateReviewRequest` out, `GateReviewResult`
  in, version-checked at runtime (`x-schema-version` + Zod). A **golden fixture** is the
  shared anchor with `judgment-engine` so neither side silently breaks the contract.
- **Sticky comment** — a single PR comment (hidden HTML marker) that updates in place
  rather than spamming new comments.
- **Check Run** — the pass/advisory status surface; **non-blocking by default**, opt-in
  to gate merges.
- **Supersession** — superseding stale review work when the PR head advances.
- **Capability screenshot URLs** — annotated screenshots are served behind signed,
  capability-scoped URLs (not anonymous `/i/<id>`), so private UI stays private.
- **Fork-PR safety** — fork PRs get restricted handling (no privileged secrets /
  storageState), part of the hostile-PR model.
- **UI-DNA version stamp** — every result records `uiDnaVersion` (and engine/model/
  prompt/capture versions) so a finding is traceable to the exact genome it was judged
  against; `null` is valid before a repo has extracted UI-DNA.
- **Free / paid tiers** — billing limits review volume and depth (triage vs. deep review)
  per tier.

---

## Codebase map

Monorepo: pnpm workspace, TypeScript project references (`tsc -b`), Vitest, ESLint.

### `packages/*`
| Package | What it is |
|---|---|
| `types` | Shared boundary types: config, `GateReviewRequest`/`GateReviewResult`, feedback events, **and the golden-fixture loader** + `deriveArtifactId`. The contract source of truth. |
| `config` | `.designreview.yml` schema, Zod validation, and normalization to typed config. |
| `engine` | Client for the `judgment-engine` async job API: submit/poll/cancel, HMAC signing, preview-handoff verification, runtime contract parsing (`x-schema-version`), rate-limit + in-VPC endpoint routing. |
| `delivery` | Publishing: sticky comment upsert, Check Run conclusion mapping, finding validation + degradation decisions, screenshot annotation (SVG/sharp), baseline before/after pairs. |
| `service` | App path — Fastify server, GitHub App auth + webhook verify, minimal permissions (asserts no `contents: write`), deployment-preview discovery, BullMQ queue, orchestrator wiring, and the fail-fast production-env check. |
| `action` | Action path — Action entrypoint, GitHub API client, preview-URL discovery, preview build-fact parsing, and the env-allowlisted + resource-capped local-serve supervisor. |
| `dashboard` | Hosted-tier core logic (tested, UI-agnostic): OAuth, signed sessions, installation access, run history + finding browser, feedback stats, config UI helpers, Stripe billing. |
| `db` | Postgres: idempotent migrations, pg/PGlite executors, and RLS tenant-isolation runners. Owns `installations`, `runs`, `feedback_events`, `billing_customers`, `webhook_log`, `screenshot_artifacts`, `feedback_consumed_tokens`. |
| `redis` | Redis namespacing/keys (BullMQ, supersession, token-bucket) + connection + no-eviction assertion. |
| `secrets` | KMS envelope encryption, app/tenant secret stores + canonical secret→env-var map, redaction + output scrubbing, fork-PR storageState handling. |
| `observability` | OpenTelemetry spans + metrics for the review pipeline (the stale-publish invariant). |
| `e2e` | End-to-end acceptance harness asserting the TRD §11 Action-path criteria against a **mock** engine. |

### `apps/*`
| App | What it is |
|---|---|
| `dashboard` | Next.js (app-router) shell rendering the `@gate/dashboard` core. **Standalone** — deliberately outside the `tsc -b`/Vitest/ESLint harness, built with `next build`. |
| `dashboard` | Next.js (app-router) shell rendering the `@gate/dashboard` core. **Standalone** — deliberately outside the `tsc -b`/Vitest/ESLint harness, built with its own isolated `next build` CI job. |

---

## Current status

Be honest about what's real:

- **Action path + App path: built and tested.** Discovery, orchestration, supersession,
  delivery (sticky comment + Check Run), HMAC engine handoff, RLS, billing, and the
  hostile-PR Action supervisor (local-serve + scrubbed Check Run tail + ulimit cap +
  configurable readiness) are all implemented with the green CI gate.
- **Dashboard core: built and tested.** The `@gate/dashboard` core (OAuth → run history
  → findings → stats → config → billing) is complete.
- **`apps/dashboard` Next.js shell: built, standalone, and Next-build verified.** The app
  shell consumes the tested core, has its own `package-lock.json`, and keeps React/Next
  outside the root `pnpm lint · typecheck · test` harness. The tested core now includes
  the object-storage result loader (`loadRunResult`); the app binds the runtime signed-URL
  seam. The remaining CI hardening is an isolated dashboard `next build` job tracked in
  issue **#83**.
- **`apps/dashboard` Next.js shell: built and isolated.** The app shell consumes the
  tested core, keeps React/Next outside the root pnpm workspace, and has its own
  CI job that builds the root `@gate/*` packages before running `npm ci` +
  `next build` in `apps/dashboard`. The object-storage result URL signer remains
  a go-live provisioning seam under issue **#64**.
- **Go-live: human/ops provisioning.** Cloud accounts, secrets, KMS, and branch protection
  are operator actions, not code. The **code seam** is done (a fail-fast boot check that
  refuses to serve if required env vars are missing). See [`docs/go-live.md`](docs/go-live.md)
  and issue **#64**.

[`PROGRESS.md`](PROGRESS.md) is the live, per-issue checklist — treat it as the source of
truth for what's done vs. `[~]` open.

---

## Getting started

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm lint   # the green gate; all three must pass
```

> `apps/dashboard` is **not** part of this gate. Build it separately from
> `apps/dashboard` with `npm ci && npm run build`; the isolated CI job is tracked in #83.
> `apps/dashboard` is **not** part of this root gate. CI builds it in a separate job:
> root `pnpm build`, then `npm ci && npm run build` from `apps/dashboard`.

**Test rules:** there is **no live model and no live network in tests** — the engine is
always **mocked**, and capture/preview runs in a sandbox. Keep it that way.

**Where the deep docs live:**
- [`PRD.md`](PRD.md) — product requirements + wedge narrative
- [`TRD.md`](TRD.md) — build-ready technical requirements (contract, env, invariants)
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — diagrams, data flow, repo boundaries, failure modes
- [`ECOSYSTEM.md`](ECOSYSTEM.md) — Gate's place in the Apature platform
- [`RESEARCH.md`](RESEARCH.md) — market + technical backing
- [`AGENTS.md`](AGENTS.md) / [`LOOP.md`](LOOP.md) — how the autonomous build loop works
- [`docs/`](docs/) — go-live, threat model, marketplace listing, demos, hardening
- [`gate_architecture.png`](gate_architecture.png) — one-page architecture poster

---

## Product boundary (read once)

Gate **judges and verifies**. It never edits customer code, never commits fixes, and never
requests `contents: write`. Check Runs are **advisory by default** — a repo must explicitly
opt into blocking before a design finding can fail a merge gate. Gate is **not** visual
regression, source-code review, or browser automation.
