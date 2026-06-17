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
   per commit. **Keep going until the usage limit — be session-usage-aware.**
   Do not stop after one issue, and do not stop at low usage (e.g. <80%). A large
   conversation/context is NOT a reason to stop — only actual session-usage
   exhaustion is. Keep implementing the next unblocked issue to maximize utility.
   Only stop early when usage is genuinely near the limit AND starting a new
   issue wouldn't fit — then wrap up loose ends (LOOP.md log, PR description).
   Never leave the tree red or a commit half-done.
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
- 2026-06-17: M1 tail (#12,#22,#40,#51) + M2 orchestrator core
  (#1,#2,#55,#3,#48,#4). Learnings:
  - **`sharp`** installs a prebuilt native binary via corepack/pnpm fine on
    darwin; test pure SVG generation separately from the one sharp round-trip.
  - **Infra that needs a live server** (BullMQ Queue/Worker, Redis store): ship
    the interface + a tested in-memory reference impl + a thin untested adapter
    (`createBull*` / `createRedis*`). The reference impl proves the semantics
    (supersession, cooperative cancel) the adapter must honor.
  - **BullMQ generics** don't structurally match a hand-written `QueueLike` —
    cast `queue as unknown as QueueLike`, and DON'T over-annotate the factory
    return type as `Queue<T>` (let it infer; the 6-param generic won't match).
  - **Dedupe transitive deps with a pnpm override.** bullmq pulled ioredis 5.11
    while `@gate/redis` had 5.10 → two copies, incompatible nominal types. Add
    `pnpm.overrides` in root package.json; the lockfile must update so CI's
    `--frozen-lockfile` stays consistent (verify with a frozen install).
  - **Octokit:** `@octokit/app` `mintAppJwt` (type:"app") is offline-testable
    (generate an RSA key with `node:crypto`); `getInstallationToken` needs
    network. `@octokit/webhooks` `verify` is testable with a computed HMAC.
    Capture the raw body for HMAC via `app.addContentTypeParser("application/
    json", { parseAs: "string" }, ...)`.
  - **Threading an AbortSignal** into the engine: add `signal?` to `PollOptions`
    and check it at stage boundaries (throw a typed `EngineAbortedError`) —
    smaller blast radius than adding a `PollOutcome` variant (which would force
    every `decideDelivery` branch to change).
  - **vitest aliases** mean a test can import any `@gate/*` without a tsconfig
    project reference; still add the workspace dep to package.json for pnpm
    linking + intent. tsconfig `references` are only needed when `src/` imports
    the package.
  - **Action `runAction` pattern:** keep the orchestrator pure with injected
    deps (engine client, GitHub api, publishCheckRun) and a thin impure
    `main.ts` entry — the orchestration is fully unit-testable, the entry isn't.
- 2026-06-17: M2 App path complete (#1,#2,#55,#3,#48,#4,#5,#6,#7,#43,#49,#9,
  #21,#13,#41,#23,#28,#52) in one usage-aware run. Learnings:
  - **The store/sink/policy pattern scales the orchestrator.** Each concern is a
    small interface with an in-memory impl (tested) + a SQL/HTTP adapter:
    SupersessionStore, FullReviewWindowStore, FeedbackStore/Sink/Forwarder,
    WebhookDedupeStore, ConsumedTokenStore, TenantDeleter. `runHostedReview`
    (#23) and `runAction` (#22) compose them with injected deps — fully testable.
  - **pglite tests for SQL adapters** validate INSERT/DELETE against the real
    migrated schema; as superuser they bypass RLS (fine for schema checks). Only
    the RLS suite needs the non-superuser role.
  - **Fastify raw body for HMAC:** `addContentTypeParser("application/json",
    {parseAs:"string"})` to verify the webhook signature; a separate
    urlencoded parser for the POST feedback form.
  - **One-time tokens:** HMAC body+sig (base64url) + a `jti` + a consumed-store;
    GET stays inert (confirm page renders a POST form, never mutates).
  - **Crypto-shredding** needs a per-tenant key that can actually be destroyed
    (`InMemoryTenantKms` deletes the key → unwrap throws). LocalKms (HKDF from a
    root) can't shred a derived key, so it's not the shredding impl.
  - **Supersession is three independent layers** that compose: queue jobId
    (`repo#pr`, structural), AbortSignal threaded into the engine poll loop
    (`signal` in PollOptions → EngineAbortedError), and the publish-time SHA
    guard (the queue-agnostic backstop, holds even if the signal is bypassed).
- 2026-06-17: M3 hosted tier complete (#15,#16,#17,#18,#19,#20,#29,#53,#54).
  Learnings:
  - **Next.js/React UI doesn't fit the tsc-b/vitest harness** — build the
    dashboard *core* as a tested TS library (`@gate/dashboard`: OAuth/session/
    access/stats/billing/config-ui/onboarding/enterprise) the React shell
    consumes; keep rendering out of the unit harness. This delivered every
    dashboard issue's acceptance without bloating the build with `next`/`react`.
  - **Circular deps between issues happen** (#20 ↔ #53). Build the lower-layer
    capability first (#53 engine routing) and note the inversion; don't stall.
  - **GitHub deep-links replace writes:** the config UI "propose" path is a
    prefilled `github.com/{o}/{r}/new/{branch}?filename=&value=` URL the user
    commits — preserves the no-`contents:write` neutrality guarantee.
  - **Stripe/SSO/webhook signatures** are all the same HMAC-verify shape with a
    timestamp tolerance; reuse the pattern (engine #47, feedback #13, stripe #19).
  - **Tracking/docs issues** (#51, #54): ship a markdown doc + a guard test that
    asserts the doc covers the required sections, so the doc can't silently drift.
