# LOOP.md — self-improving build playbook

This file is the autonomous build loop's accumulated know-how. The loop **reads
it at the start of every run** and **updates it at the end of every run** with
anything that would make the next run faster, safer, or higher quality. Treat it
as living memory: append concrete learnings, prune anything that proved wrong.

## How to run (each fire)

1. Sync: `git fetch`, checkout `agent/build`, `git pull --ff-only`, merge
   `origin/main` (stop only if conflicts are non-trivial).
2. Read this file, then `PROGRESS.md` and the plan docs.
3. Work issues top-down (first `[ ]` whose deps are `[x]`), one coherent slice
   per commit. **Keep going until the usage limit** — do not stop after one
   issue. Only stop early if wrapping up loose ends and a new issue wouldn't fit
   in the remaining budget; never leave the tree red or a commit half-done.
4. Verify every slice: `pnpm install` (if deps changed), `pnpm typecheck`,
   `pnpm test`, `pnpm lint` — all green before committing.
5. Flip `PROGRESS.md`, commit (plain message, **no AI attribution**), push,
   update PR #57, comment on the issue.
6. **Before ending, improve this file** with new learnings from the run.

## Conventions established (follow these — don't rediscover)

- **Package layout:** one package per concern under `packages/*`, each with its
  own `tsconfig.json` (`rootDir: src`, `outDir: dist`) added to the root
  `tsconfig.json` `references` array. Tests live in `packages/*/test/**` (not in
  `src`, so they're excluded from `tsc -b`); vitest picks them up via the root
  `vitest.config.ts` include glob.
- **Mock engine:** build against `loadGoldenReviewResult()` / the golden fixture
  from `@gate/types`. Never call a real engine.
- **Cross-package test imports** (e.g. a test in `@gate/action` importing
  `@gate/config`) require adding the package to that package's
  `devDependencies` as `workspace:*`, then `pnpm install`. Source-level deps go
  in `dependencies` + a tsconfig `references` entry.
- **Vitest resolves `@gate/*` to source** via `resolve.alias` in the root
  `vitest.config.ts` (each maps to `packages/<name>/src/index.ts`). When you add
  a NEW package, add it to that alias map too. This means tests run against
  source, not `dist/`, so a build is NOT required before `pnpm test`.
- **Verify order:** `pnpm install` (if deps changed) → `pnpm typecheck`
  (`tsc -b`, catches type errors) → `pnpm test` → `pnpm lint`. Build-before-test
  is no longer required for module resolution (see alias note above).
- **ESM everywhere:** `"type": "module"`, NodeNext, `verbatimModuleSyntax`. Use
  `import type` for type-only imports and `.js` extensions in relative imports.
- **Prefer real, in-process tests over mocks of infra:**
  - Postgres: embedded **PGlite** (`@electric-sql/pglite`) — runs real PG16 SQL
    (gen_random_uuid, jsonb, RLS) in tests with no provisioning.
  - OpenTelemetry: `InMemoryMetricExporter` + `PeriodicExportingMetricReader`
    (flush via `meterProvider.forceFlush()`), and `InMemorySpanExporter` +
    `SimpleSpanProcessor` from `@opentelemetry/sdk-trace-base`.
- **Infra issues are mocked, not provisioned.** Implement the runner/client/
  schema/config and test it; leave real provisioning (Neon/Fly/Upstash/KMS/
  branch-protection) as explicit "NOTE: ops step" lines in PROGRESS + the PR.

## Gotchas / fixes (so the next run doesn't repeat them)

- OpenTelemetry **1.30** `@opentelemetry/resources` exports `Resource` (use
  `new Resource({...})`), NOT `resourceFromAttributes` (that's 2.x).
  `@opentelemetry/semantic-conventions` has `ATTR_SERVICE_NAME` /
  `ATTR_SERVICE_VERSION`. `NodeTracerProvider` accepts `spanProcessors` in its
  constructor (no `addSpanProcessor` needed).
- **RLS + PGlite:** PGlite's default client is a superuser and **bypasses RLS
  even with FORCE**. Test isolation under a `NOSUPERUSER` role: `CREATE ROLE
  gate_app NOSUPERUSER; GRANT ... TO gate_app;` then `SET LOCAL ROLE gate_app`
  inside the tenant transaction. FK checks bypass RLS, so cross-tenant FKs still
  validate.
- Use `set_config('app.current_installation_id', $1, true)` (transaction-local)
  for the tenant GUC — `SET LOCAL name = $1` can't be parameterized.
- `git checkout <file>` to drop a temp change will also revert *other* unstaged
  edits to that file — re-apply intended edits after.
- Keep `lint` as `eslint . --max-warnings=0` (warnings fail the build, #31).

## Self-improvement log (newest first)

- 2026-06-16: Initialized playbook after M0 (#30,#31,#32,#33,#34,#35,#36,#50) +
  M1 #27/#8. Established the conventions and gotchas above.
- 2026-06-16: A maintainer added vitest `resolve.alias` so `@gate/*` → source.
  Tests no longer need a prior build; remember to extend the alias map for each
  new package. Also: another committer may push to `agent/build` between runs —
  always `git fetch` + rebase before pushing.
- 2026-06-16: M1 engine+delivery vertical (#45,#37,#47,#39,#46,#10,#11,#38).
  Learnings:
  - **Verify dependency direction, not just PROGRESS order.** #45's stated
    "depends on #37" was inverted — the async job *contract* precedes the
    *client*. When a dep looks circular/backwards, build the lower layer first
    and note the inversion in PROGRESS + the issue comment.
  - **Cross-repo `[judgment-engine #N]` deps never block** — mock them; only
    in-repo `[ ]` deps gate an issue.
  - **Consolidate scaffold helpers.** When a real issue (#11) supersedes a
    placeholder from the #30 scaffold (`@gate/service` check-run helper), move
    the canonical impl to the owning package (`@gate/delivery`) and have the old
    location re-export it — don't leave two implementations.
  - **Package layering:** `engine` is lower-level than `delivery`; `delivery`
    depends on `engine` (for `PollOutcome`), never the reverse. Keep deps
    pointing toward `types`.
  - **ESLint:** `_`-prefixed and rest-sibling unused vars are ignored (config
    updated) — use `const { dropped: _drop, ...rest }` to omit keys in tests.
  - Layer security/contract concerns as transport seams: HMAC (#47), Zod parse
    + `x-schema-version` (#46), and Retry-After (#38) all wrap the same
    `EngineTransport`/client without rewriting the job protocol (#45).
