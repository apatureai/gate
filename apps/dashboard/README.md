# Apature Gate dashboard app (#63)

Next.js (app-router) shell that renders the fully-tested `@gate/dashboard` hosted-tier **core** (OAuth, sessions, installation-scoped access, run history, finding browser, feedback stats, config UI, billing). The app is a **thin consumer**: all logic lives in `@gate/dashboard` / `@gate/service` / `@gate/types`; the pages just wire them to routes.

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
npm ci                           # installs Next + React from package-lock.json
npm run build                    # next build  ← the CI check for this app (see "CI wiring" below)
npm run dev                      # local dev
```

## Dependency hygiene

The app keeps its own `package-lock.json` and npm audit path. `package.json` pins a
narrow npm `overrides.postcss = 8.5.10` entry because supported Next 15 releases still
declare `postcss@8.4.31`, which is below the patched line for GHSA-qx2v-qp2m-jg93. Drop
the override once Next depends on a patched PostCSS release directly and
`npm audit --audit-level=moderate` remains clean.

**Archived, unmaintained.** This app's dependency tree was frozen at the archive cut
and `npm audit` reports known high-severity advisories (Next.js; postcss, which the override
above now pins *below* the patched line; nanoid; and sharp via libvips). The root
pnpm workspace is clean; this tree is not. Update before running it anywhere real, and
do not blind-`npm audit fix` (it pulls a major Next bump).

## CI Wiring

Root CI keeps the framework-free package gate (`pnpm lint`, `pnpm typecheck`,
`pnpm test`) separate from the Next toolchain. A second `dashboard next build`
job installs the root pnpm workspace, builds the `@gate/*` package `dist/`
outputs, then runs `npm ci` and `npm run build` in this directory. That ordering
is required because the app depends on the local packages through `file:` links.

## Required env

| Variable | Purpose |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | GitHub OAuth app |
| `DASHBOARD_SESSION_SECRET` | HMAC for the signed session cookie |
| `DASHBOARD_BASE_URL` | Public base URL (OAuth redirect) |
| `DATABASE_URL` | Postgres (non-superuser, no BYPASSRLS, so RLS holds) |
| `GATE_ARTIFACT_BASE_URL` | Engine base URL serving `/i/<id>.png` |
| `GATE_RESULT_OBJECT_URL_TEMPLATE` | Absolute stored-result JSON URL template containing `{runId}` |
| `SCREENSHOT_CAPABILITY_SECRET` | Mint short-lived screenshot capability tokens (#61) |

## Pages

- `/api/auth/login` → GitHub OAuth; `/api/auth/callback` → mint signed session; `/api/auth/logout`.
- `/[installationId]`: repo picker (access enforced via `assertInstallationAccess`).
- `/[installationId]/runs`: `listRunHistory`.
- `/[installationId]/findings` + `/findings/[runId]`: `buildFindingBrowser`; screenshots via **capability URLs** (`mintScreenshotCapability` + `capabilityScreenshotUrl`, #61), never anonymous `/i`.
- `/[installationId]/feedback`: `computeFeedbackStats` / `feedbackTrend`.
- `/[installationId]/config`: `validateConfig` + `buildProposeConfigUrl` (user opens the PR; Gate never writes, no `contents: write`).
- `/[installationId]/billing`: plan/status + `computeMonthlyTotalCents`.

## Remaining wiring

- **Result object URL provisioning (#64 go-live):** `src/lib/results.ts` binds the tested
  `@gate/dashboard` result loader through `GATE_RESULT_OBJECT_URL_TEMPLATE`
  (`createTemplateResultUrlSigner`). Production still needs the ops-owned object store
  provisioned and the template (or a real short-lived signed-GET signer) configured.

(The isolated CI `next build` job from #83 is in place; see `.github/workflows/ci.yml`.)
