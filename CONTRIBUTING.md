# Contributing

**This project is archived.** Apature Gate was a commercial product that has been
wound down; the source is published so it stays useful to whoever wants it.

What that means in practice:

- **Pull requests and issues are not being reviewed.** You can still open them;
  nobody is watching. Assume anything you file sits unread indefinitely.
- **Forking is the intended path.** Fork it, rename it, change the boundaries,
  ship it. The MIT license (see [`LICENSE`](LICENSE)) permits all of that with
  no permission needed.
- **No support, no roadmap, no releases.** Nothing here is published to a package
  registry, and nothing will be.

The rest of this file is build instructions, so a fork starts from a working
tree instead of guesswork.

## Building it

Requirements:

- **Node 24** (pinned in [`.node-version`](.node-version); `package.json` requires
  `>=24`)
- **pnpm 10.34.3** (pinned via `packageManager`; `corepack enable` will pick it up)

The root workspace is `packages/*`, a pnpm workspace with TypeScript project
references, Vitest, and ESLint:

```bash
pnpm install --frozen-lockfile
pnpm typecheck   # tsc -b across the project references
pnpm test        # vitest
pnpm lint        # eslint . --max-warnings=0
```

All three must pass; lint treats warnings as failures. `pnpm build` is the same
`tsc -b`, and `pnpm clean` runs `tsc -b --clean`.

The Next.js dashboard shell in `apps/dashboard` is deliberately **outside** the
root workspace. It keeps React/Next in its own `package-lock.json` and builds
with its own toolchain, exactly as CI does it:

```bash
pnpm build
cd apps/dashboard
npm ci
npm run build
```

A copy of the environment the shell expects is in `apps/dashboard/.env.example`.

Note that `next build` rewrites `apps/dashboard/tsconfig.json` and
`apps/dashboard/next-env.d.ts` to its own canonical form, so your working tree
will look dirty after a dashboard build. That is Next.js, not you.

## Running the tests

Tests need no external services. Postgres is exercised through PGlite
in-process, and everything else uses in-memory fakes. Two rules held throughout
the project and are worth keeping in a fork, because breaking them makes the
suite non-deterministic and expensive:

- **No live model calls and no live network in tests.** The judgment engine is
  always mocked; the cross-repo wire contract is anchored by a golden fixture in
  `@gate/types`.
- **No real capture.** Preview capture is stubbed, never launched against a real
  site.

Vitest picks up `packages/*/test/**/*.test.ts` and aliases each `@gate/*` package
straight to its source (see [`vitest.config.ts`](vitest.config.ts)), so tests run
without a build step. The suites that boot PGlite are the slowest in the repo,
which is why that config raises `testTimeout`/`hookTimeout` above the vitest
defaults. Don't lower them.

## Codebase conventions

These held across the whole build, and a fork that follows them will find the
tree behaves predictably:

- **One package per concern** under `packages/*`, each with its own
  `tsconfig.json` (`rootDir: src`, `outDir: dist`) listed in the root
  `tsconfig.json` `references` array. Tests live in `packages/*/test/**` rather
  than in `src`, so `tsc -b` ignores them and Vitest picks them up from the root
  config's include glob.
- **ESM throughout**: `"type": "module"`, `NodeNext` resolution,
  `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. Type-only imports use
  `import type`, and relative imports carry the `.js` extension.
- **Adding a package** means three edits, not one: the tsconfig `references`
  entry, the `resolve.alias` entry in `vitest.config.ts` (each `@gate/*` maps to
  `packages/<name>/src/index.ts`), and a `workspace:*` dependency wherever it is
  consumed. A test that imports another package needs that package in the
  consuming package's `devDependencies`; source-level use goes in `dependencies`
  plus a tsconfig reference.
- **Infrastructure is exercised in-process, not provisioned.** Postgres runs
  through PGlite, OpenTelemetry through the in-memory span and metric exporters,
  everything else through hand-written fakes. Real hosts (Postgres, Redis, KMS)
  are a deployment concern, never a test one.

Two Postgres details are easy to get wrong and cost real time:

- **PGlite's default client is a superuser and bypasses row-level security even
  with `FORCE`.** The tenant-isolation suite therefore creates a `NOSUPERUSER`
  role and does `SET LOCAL ROLE gate_app` inside the transaction; without that,
  the RLS tests pass vacuously. Foreign-key checks bypass RLS regardless, so
  cross-tenant FKs still validate.
- The tenant GUC is set with `set_config('app.current_installation_id', $1,
  true)`, which is transaction-local, because `SET LOCAL name = $1` cannot be
  parameterized.

## Container images

Two images are built from the frozen lockfile: [`Dockerfile`](Dockerfile) for the
hosted App path and [`Dockerfile.action`](Dockerfile.action) for the Action path.

```bash
docker build --file Dockerfile --tag gate-app .
docker build --file Dockerfile.action --tag gate-action .
```

Both were built, booted against Postgres and Redis, migrated, health-checked and
shut down cleanly in CI while the project was maintained. That job (image build,
SBOM generation, and the vulnerability gate) was removed for the archive because
it gated on base-image CVE drift and would have gone permanently red with no one
to fix it. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) now runs only
lint/typecheck/test and the dashboard build.

## Orientation

- [`README.md`](README.md) is the documentation: what Gate is, the runnable demos, the
  engine contract, the Action-path threat model, failure modes, configuration and the package map
- [`SECURITY.md`](SECURITY.md) is worth reading before you run this against anything real

One boundary is load-bearing across the whole codebase: **Gate judges and
verifies, it never edits code.** It publishes PR comments and Check Runs and
never requests `contents: write`. If you change that in a fork, the tests that
guard it (`assertNoContentsWrite`) will tell you, and the README will no longer
describe what you are running.
