# Contributing

Contributions are welcome. Issues and pull requests are read.

The fastest way to find something worth doing is the **Roadmap** section of
[`README.md`](README.md#roadmap): ten concrete items, each naming the file or
interface it plugs into. Items 2 (a fixture-backed transport on `@gate/engine`'s
public surface) and 5 (dependency advisories) are good first issues. Item 1 (a
reference critique service) is the one that unlocks the most.

Small fixes need no preamble: open a pull request. For anything that changes a
public interface, a database schema, or one of the invariants below, open an
issue first so the design discussion happens before the work.

## Setup

Requirements:

- **Node 24** (pinned in [`.node-version`](.node-version); `package.json`
  requires `>=24`)
- **pnpm 10.34.3** (pinned via `packageManager`; `corepack enable` picks it up)
- **macOS or Linux.** The supervisor relies on POSIX process groups.

```bash
pnpm install --frozen-lockfile
pnpm lint        # eslint . --max-warnings=0
pnpm typecheck   # tsc -b across the project references
pnpm test        # vitest
```

All three must pass before a pull request is merged, and lint treats warnings as
failures. `pnpm build` is the same `tsc -b` as typecheck but keeps the emitted
`dist/`; `pnpm clean` runs `tsc -b --clean`.

Run one test file with `pnpm exec vitest run packages/action/test/local-serve.test.ts`.

Sanity-check your change against the two demos, which exercise the supervisor and
the whole delivery path with no credentials:

```bash
pnpm demo         # ends in PASS, orphans: 0, leaked none
pnpm demo:review  # writes four files to ./out
```

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
`apps/dashboard/next-env.d.ts` to its own canonical form. Both are committed in
their post-build form, so a build on a clean tree leaves `git status` clean; if
you upgrade Next, expect one commit of regenerated churn.

## What kinds of contributions are wanted

- **Roadmap items.** Anything in the README's roadmap. Say on the issue that you
  are picking it up so two people do not write the same adapter.
- **The supervisor.** `packages/action/src/local-serve.ts` and `resource-cap.ts`
  are the most reused part of this repository. Hardening, platform coverage, and
  tests that demonstrate a containment property live are all valuable. A test
  that proves something escapes is more valuable still.
- **Adapters at the marked seams.** Object stores, transports, baseline stores.
  Each is already an interface with tests around it.
- **Docs that fix a wrong claim.** If something in the README does not match what
  the code does, that is a bug and a pull request fixing either side is welcome.
- **Test coverage of failure modes.** The failure-mode table in the README is the
  specification; a row without a test is fair game.

Two things that will not be merged: anything that gives Gate write access to
repository contents (see invariants), and anything that puts a live network call
or a real model call into the test suite.

## Running the tests

Tests need no external services. Postgres is exercised through PGlite in-process,
and everything else uses in-memory fakes. Two rules are load-bearing, because
breaking them makes the suite non-deterministic and expensive:

- **No live model calls and no live network in tests.** The critique service is
  always mocked; the cross-repo wire contract is anchored by a golden fixture in
  `@gate/types`.
- **No real capture.** Preview capture is stubbed, never launched against a real
  site.

Vitest picks up `packages/*/test/**/*.test.ts` and aliases each `@gate/*` package
straight to its source (see [`vitest.config.ts`](vitest.config.ts)), so tests run
without a build step. The suites that boot PGlite are the slowest in the repo,
which is why that config raises `testTimeout`/`hookTimeout` above the vitest
defaults. Do not lower them.

## Codebase conventions

- **One package per concern** under `packages/*`, each with its own
  `tsconfig.json` (`rootDir: src`, `outDir: dist`) listed in the root
  `tsconfig.json` `references` array. Tests live in `packages/*/test/**` rather
  than in `src`, so `tsc -b` ignores them and Vitest picks them up from the root
  config's include glob.
- **ESM throughout**: `"type": "module"`, `NodeNext` resolution,
  `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. Type-only imports use
  `import type`, and relative imports carry the `.js` extension. Forgetting the
  extension is the single most common build failure here.
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
- **No em dashes in prose**, in docs or in code comments.

Two Postgres details are easy to get wrong and cost real time:

- **PGlite's default client is a superuser and bypasses row-level security even
  with `FORCE`.** The tenant-isolation suite therefore creates a `NOSUPERUSER`
  role and does `SET LOCAL ROLE gate_app` inside the transaction; without that,
  the RLS tests pass vacuously. Foreign-key checks bypass RLS regardless, so
  cross-tenant FKs still validate.
- The tenant GUC is set with `set_config('app.current_installation_id', $1,
  true)`, which is transaction-local, because `SET LOCAL name = $1` cannot be
  parameterized.

## Invariants

These hold across the whole codebase, and a change that breaks one needs an issue
and a discussion, not just a green build:

- **Gate judges and verifies; it never edits code.** It publishes PR comments and
  Check Runs and never requests `contents: write`. `assertNoContentsWrite` fails
  the build if a permission set tries to grant it.
- **The supersession key is `repo#pr`; the completed-review identity is
  `(repo_owner, repo_name, pr_number, head_sha)`.** They are different on
  purpose. Conflating them either double-posts or drops reviews.
- **The publish-time SHA guard is not optional.** `stale_publish_rate` has a
  target of exactly zero, not an SLO.
- **A broken reviewer never fails a pull request.** Every failure path ends in a
  neutral Check Run with an explanation.
- **A malformed or version-drifted result publishes nothing.** Never a comment
  full of nulls.

## How pull requests get reviewed

CI runs `lint · typecheck · test` plus an isolated `next build` for the
dashboard ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). A pull
request needs all of it green.

Beyond green, review looks for: a test that would have failed before the change;
docs updated in the same pull request when behaviour changes; no new live network
in the suite; and no drift from the invariants above. Small, focused pull
requests get reviewed faster than large ones.

## Container images

Two images build from the frozen lockfile: [`Dockerfile`](Dockerfile) for the App
path and [`Dockerfile.action`](Dockerfile.action) for the Action path.

```bash
docker build --file Dockerfile --tag gate-app .
docker build --file Dockerfile.action --tag gate-action .
```

CI does not build them today. Restoring that job, together with SBOM generation
and a vulnerability gate that has a sane policy for base-image CVE drift, is
roadmap item 10.

## Orientation

- [`README.md`](README.md) is the documentation: what Gate is, the runnable
  demos, the service contract, the Action-path threat model, failure modes,
  configuration, the package map and the roadmap.
- [`SECURITY.md`](SECURITY.md) is the policy and the checklist to read before
  running this against anything real.
