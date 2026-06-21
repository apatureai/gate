# Apature Gate — dashboard app (#63)

Next.js (app-router) shell that renders the fully-tested `@gate/dashboard` hosted-tier **core** (OAuth, sessions, installation-scoped access, run history, finding browser, feedback stats, config UI, billing). The app is a **thin consumer** — all logic lives in `@gate/dashboard` / `@gate/service` / `@gate/types`; the pages just wire them to routes.

## Why it's outside the monorepo harness

React/Next is intentionally kept out of the root `tsc -b` / vitest / `eslint .` harness (the core stays framework-free and unit-tested). So:

- `apps/**` is **not** in `pnpm-workspace.yaml` (root `pnpm install --frozen-lockfile` never pulls Next).
- `apps/**` is in the root **eslint ignores** (`eslint .` won't parse the TSX).
- It is **not** in the root tsconfig references (`tsc -b` skips it) and not in the vitest globs.

This keeps the CI `lint · typecheck · test` job green. The app builds with its own toolchain.

## Build / run

```bash
pnpm -w -r build                 # build the @gate/* packages first (the app uses their dist via file: links)
cd apps/dashboard
pnpm install                     # installs Next + React (needs disk; not run in the root CI)
pnpm build                       # next build  ← the CI check for this app (see "CI wiring" below)
pnpm dev                         # local dev
```

## Required env

| Variable | Purpose |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | GitHub OAuth app |
| `DASHBOARD_SESSION_SECRET` | HMAC for the signed session cookie |
| `DASHBOARD_BASE_URL` | Public base URL (OAuth redirect) |
| `DATABASE_URL` | Postgres (non-superuser, no BYPASSRLS, so RLS holds) |
| `GATE_ARTIFACT_BASE_URL` | Engine base URL serving `/i/<id>.png` |
| `SCREENSHOT_CAPABILITY_SECRET` | Mint short-lived screenshot capability tokens (#61) |

## Pages

- `/api/auth/login` → GitHub OAuth; `/api/auth/callback` → mint signed session; `/api/auth/logout`.
- `/[installationId]` — repo picker (access enforced via `assertInstallationAccess`).
- `/[installationId]/runs` — `listRunHistory`.
- `/[installationId]/findings` + `/findings/[runId]` — `buildFindingBrowser`; screenshots via **capability URLs** (`mintScreenshotCapability` + `capabilityScreenshotUrl`, #61), never anonymous `/i`.
- `/[installationId]/feedback` — `computeFeedbackStats` / `feedbackTrend`.
- `/[installationId]/config` — `validateConfig` + `buildProposeConfigUrl` (user opens the PR; Gate never writes, no `contents: write`).
- `/[installationId]/billing` — plan/status + `computeMonthlyTotalCents`.

## Remaining wiring (deferred — needs a disk-capable build env)

- **CI `next build` job:** add a separate workflow job (own `pnpm install` inside `apps/dashboard`) so a Next build break is isolated from the core `lint · typecheck · test` check. Not added yet because `next build` could not be run/verified in the authoring environment (near-full disk).
- **`loadRunResult` (`src/lib/results.ts`):** the full `GateReviewResult` lives in object storage (the `runs` table is metadata only); wire the R2/S3 loader so the finding browser renders stored results.
