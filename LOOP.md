# LOOP.md — self-improving build playbook

This file is the autonomous build loop's accumulated know-how. The loop **reads
it at the start of every run** and **updates it at the end of every run** with
anything that would make the next run faster, safer, or higher quality. Treat it
as living memory: append concrete learnings, prune anything that proved wrong.

## How to run (each fire)

1. Sync: `git fetch`, checkout `agent/build`, `git pull --ff-only`, merge
   `origin/main` (stop only if conflicts are non-trivial).
2. Read this file, then `PROGRESS.md` and the plan docs.
3. Work issues top-down (first `[ ]` whose deps are `[x]` and that is not
   already implemented or covered by an active PR), one coherent slice per
   commit. If no ready issue remains, run the backlog-exhaustion protocol below
   instead of stopping. **Keep going until the usage limit — be
   session-usage-aware.**
   Do not stop after one issue, and do not stop at low usage (e.g. <80%). A large
   conversation/context is NOT a reason to stop — only actual session-usage
   exhaustion is. Keep implementing the next unblocked issue to maximize utility.
   Only stop early when usage is genuinely near the limit AND starting a new
   issue wouldn't fit — then wrap up loose ends (LOOP.md log, PR description).
   Never leave the tree red or a commit half-done.
4. Verify every slice: `pnpm install` (if deps changed), `pnpm typecheck`,
   `pnpm test`, `pnpm lint` — all green before committing.
5. Flip `PROGRESS.md`, commit (plain message, **no AI attribution**), push,
   update the current open build PR (or open a new one if the previous PR was
   merged/closed), and comment on the issue.
6. **Before ending, improve this file** with new learnings from the run.

## Backlog-exhaustion protocol

An empty ready queue is a discovery trigger, not a terminal condition.

1. Re-fetch GitHub state and classify every open issue: implemented on `main`,
   covered by an active PR, blocked by in-repo dependencies, blocked by external
   provisioning, premature for the YC sequence, or ready. Do not rely only on
   issue state or `PROGRESS.md`; inspect commits, files, and tests.
2. If no ready unclaimed issue exists, audit the current codebase for concrete
   gaps. Prioritize:
   - broken or missing end-to-end wiring and composition roots;
   - production adapters/configuration that exist only as in-memory seams;
   - correctness and security invariants without enforcement or regression
     tests (tenant isolation, fork safety, stale-publish prevention, advisory
     defaults, secret redaction);
   - failure paths, retries, cancellation, idempotency, and rate-limit handling;
   - CI/build/container/deploy drift and missing smoke tests;
   - docs or acceptance claims that exceed what the code actually implements;
   - `TODO`/`FIXME`, skipped tests, dead helpers, uncalled code, and weak type or
     runtime-contract boundaries.
3. Validate each candidate against the architecture and product docs. Reject
   work that moves capture/model/eval into Gate, requests `contents: write`,
   edits customer code, weakens advisory defaults, breaks fork safety, or is
   only external provisioning/account-plan work.
4. Search open issues and PRs again for each candidate. Never create a duplicate
   issue or compete with active implementation.
5. Create a small ordered set of GitHub issues for confirmed gaps (normally
   1–3, not a speculative roadmap). Every generated issue must include:
   - the observed problem and code/test evidence;
   - why it matters to the YC golden path;
   - complete, testable acceptance criteria;
   - explicit dependencies and owner-repo boundary;
   - relevant PRD/TRD/ARCHITECTURE references;
   - area/type/priority/size labels and the appropriate milestone when present.
6. Update `BACKLOG.md`/`PROGRESS.md` only when the new issue changes canonical
   execution order. Keep generated work narrow enough for one coherent PR.
7. Re-run readiness selection and implement the highest-priority ready P0/P1
   issue created by the audit. If the audit finds no defensible code or docs
   gap, create nothing rather than fabricating work; record the evidence and the
   next external dependency required.

Issue generation is not permission to invent features. It is a mechanism for
turning verified implementation, integration, reliability, security, and
documentation gaps into reviewable work.

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
- **Close issues via the PR.** Put a `Closes #<N>` line in the PR body for every
  issue the PR implements — GitHub auto-closes them on merge to the default
  branch (keywords only fire on merge, not on `gh pr edit` of a merged PR, so add
  them BEFORE merge). The review-merge automation also closes any issue the
  merged PR references as a guarantee. The build loop never self-merges, so its
  issues close when a human merges the build PR.

## Self-improvement log (newest first)

- 2026-06-20: Build loop repointed here from judgment-engine (its build backlog
  is live-infra-exhausted). Merged the two Codex PRs first (#67 repo-scoped run
  identity, #68 vitest/vite security), then resolved the resulting agent/build↔main
  merge (PROGRESS conflict + regenerated pnpm-lock via `pnpm install`). Shipped
  #62 (live App-path composition root), #69 (durable RunStore), and #71
  (collision-safe screenshot artifact ids); triaged #63 [~] (Next.js app, outside
  the harness). Also merged 6 sibling-repo research PRs and left core #103 (CI
  red: empty ANTHROPIC_API_KEY). 350 tests green. Learnings:
  - **A run-local id is never an auth/route key (#71).** The engine's `findingId`
    is only unique within a run (golden fixture reuses `f_001`), so keying `/i/:id`
    + capabilities by it let a token resolve a collided artifact in another
    run/repo. Fix = a deterministic collision-safe id
    `sha256(installation:owner:name:headSha:findingId)` (`deriveArtifactId`) in the
    SHARED `@gate/types` so the App service AND dashboard derive the SAME id with
    no lookup (avoids duplication + a service↔dashboard dep).
  - **Default-deny tenant RLS is incompatible with bearer-token + capability
    reads.** `/i` serves anonymous-public + capability-private artifacts with NO
    tenant GUC, so a default-deny policy 404s them. The boundary there is the
    unguessable id + route auth (#61) + explicit `installation_id` scoping + an FK
    cascade — and DOCUMENT why RLS is omitted on that table so nobody "fixes" it.
  - **After the review-merge loop merges Codex PRs, agent/build will conflict on
    PROGRESS.md + pnpm-lock.yaml.** Resolve PROGRESS by hand (keep both the
    merged `[x]` and any agent/build hardening notes), take main's lockfile
    (`git checkout --theirs pnpm-lock.yaml`), then `pnpm install` to reconcile it
    with the merged package.json. Re-mark the Codex issues `[x] done via PR #N`.
  - **Service must not import @gate/action.** The App path needed a GitHub
    comments/check-run client; `@gate/action`'s `createGitHubApi` is the right
    shape but lives in the top consumer. Built the in-layer peer
    `createAppReviewClient` (alongside `createGitHubPullsClient`) — same pattern,
    no layering inversion.
  - **A new src-level cross-package import = add BOTH the package.json dep AND a
    tsconfig `references` entry.** Vitest's alias resolves it (tests pass) while
    `tsc -b` fails with "Cannot find module" until the project reference exists.
    `@gate/db`/`@gate/secrets` are devDeps (test-only) so they're NOT in refs;
    `@gate/config` became a real dep (DEFAULT_CONFIG in src) so it needed both.
  - **Composition roots: inject the infra-bound clients, keep one env seam.**
    `createProductionAppServer(deps)` is fully testable with fakes + a mock engine
    (a signed deployment_status → worker → hydrate → runHostedReview → publish);
    the env construction (SecretStore→App auth→engine transport→Redis/SQL) is the
    single documented go-live seam in server.ts (#64), not scattered env reads.
  - **A no-op UPDATE is a silent durability bug.** `recordFullReview` UPDATE'd
    `runs.last_full_review_at` but the hosted path never INSERT'd a run row, so the
    10-min cap reset every restart. Fix = one upsert that creates the row AND sets
    the timestamp (COALESCE so triage never clears a prior deep ts), persisting
    only completed/publish-guarded reviews.
  - **UI apps (Next.js) don't fit this loop's gate.** `next build` is a separate
    toolchain with no harness unit tests; mark such issues `[~]` (the tested core
    already exists) rather than bolting a new toolchain onto the loop.

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
- 2026-06-17: M4 trust polish complete (#14,#24,#25,#26,#42) — **the entire
  M0–M4 backlog is implemented** (290 tests). Learnings:
  - **GTM/marketing issues** (#24 listing, #25 demo, #26 OSS content) are
    doc-shaped: ship the in-repo artifact (listing draft, demo runbook, consent/
    opt-out policy) + a guard test; flag the human steps (verification, recording,
    posting) explicitly rather than pretending they're code.
  - **demo-as-test** (#42): the live-pipeline scheduled smoke test is ops, but
    the same flow runs in CI against the mock engine asserting the 90s budget +
    a post-fix green Check Run — that's the in-repo deliverable.
  - When PROGRESS has no unchecked `[ ]` whose deps are met, run the
    backlog-exhaustion protocol: audit the current implementation, create
    non-duplicate issues for confirmed gaps, and continue with the
    highest-priority ready P0/P1 issue. Do not fabricate speculative features.
- 2026-06-17: Backlog complete, but "use the full budget" → do a **hardening
  pass** on the finished build (this is legitimate, not invented work). Real
  gaps found by reviewing the wiring end-to-end:
  - `createDeploymentStatusHandler` hardcoded `installationId: ""` and bound to a
    fixed repo — fixed to read `installation.id` + `repository.owner.login/name`
    from the webhook (multi-tenant; one handler serves all installs).
  - The queue payload is IDs-only, so the worker needs `hydrateReviewContext` +
    a `PullRequestFetcher` to get PR title/body/fork before `runHostedReview`.
  - §15.3 said the AbortSignal must reach the **HTTP client**, not just the poll
    loop — threaded `signal` into `EngineTransport.poll/submit` via
    `AbortSignal.any`, converting an aborted fetch to `EngineAbortedError`.
  - The #49 rate-limit helper existed but was **unused** — moved it to the shared
    `@gate/engine` layer and wired `withRateLimitRetry` into the real GitHub
    client (`createGitHubApi`).
  - Added the App-path composition root `createAppServer` (buildServer +
    handlers) + App-path e2e — nothing assembled the App path end-to-end before.
  - **Lesson:** after the backlog is "done", the highest-value budget use is
    reviewing cross-package *wiring* (composition roots, multi-tenancy, signals,
    helpers-that-exist-but-aren't-called) — unit tests pass while the seams leak.
- 2026-06-17: **Merged-PR gotcha.** PR #57 (agent/build→main) was merged by a
  human at 03:01, but the loop kept editing the *merged* #57 via `gh pr edit` for
  hours instead of opening a fresh PR — so 56 later commits sat on agent/build
  with no open PR. Fix: step 8 now opens a NEW PR when the current agent/build→
  main PR is MERGED/CLOSED (never edit a merged PR). Check
  `gh pr view <N> --json state` before editing; if MERGED/CLOSED, `gh pr create`.
  A second automation (separate session cron) reviews + squash-merges Codex PRs
  (head != agent/build) when CI is green and the review is clean — it never
  touches agent/build, which stays for human review.
- 2026-06-17: Deep hardening review pass (10 real fixes; tests 276→302). The
  recurring meta-bug class: **a helper is implemented + unit-tested but never
  wired into the orchestration.** Audit for these specifically. Fixes:
  - engine error thrown from `engine.review` escaped both orchestrators (Action
    posted no Check Run; App worker crashed) → wired `decideDeliveryForError`
    into runAction + runHostedReview catch blocks → neutral Check Run.
  - `decideDeliveryForError` / `withRateLimitRetry` / best-effort engine
    `cancel` on supersession all existed but weren't called → wired in.
  - `redact()` guarded circular objects but not arrays → stack-overflow risk.
  - Stripe `verifyStripeSignature` only checked the last `v1` → breaks during
    webhook-secret rotation (Stripe sends multiple `v1`); now accepts any match.
  - in-memory `ReviewJobWorker` pump didn't isolate a throwing job → one bad job
    stalled the queue / unhandled rejection; now catch+continue like BullMQ.
  - AbortSignal reached only the poll loop, not the HTTP client (§15.3) → threaded
    `signal` into `EngineTransport.poll/submit` via `AbortSignal.any`.
  - App webhook handlers were single-repo + hardcoded `installationId:""` →
    multi-tenant from the payload; added `hydrateReviewContext` (IDs-only payload)
    + `createAppServer`/`createAppWebhookHandlers` composition roots + e2e.
  - **Checklist for a "done" build:** error path → neutral, not crash/throw;
    abort/supersession → cancel upstream + guard publish; signature verifiers →
    rotation + length-mismatch; recursion → circular guard on arrays AND objects;
    every `createX`/`decideX` helper → grep that something actually calls it.
- 2026-06-17: **Backlog exhaustion now triggers issue discovery.** Do not stop
  merely because every existing issue is implemented or claimed by an active
  PR. Audit the current codebase and end-to-end wiring, create 1–3
  non-duplicate issues for confirmed actionable gaps with full acceptance
  criteria/dependencies/labels, then implement the highest-priority ready P0/P1
  issue. Preserve the YC sequence and hard architecture boundaries; never
  manufacture speculative work just to keep the loop busy.
