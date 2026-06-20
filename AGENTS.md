# AGENTS.md — Apature Gate

Vendor-neutral guide for AI coding agents (Claude Code, Codex, OpenClaw, etc.).
Complements `CLAUDE.md` and `LOOP.md`. Read this before working in the repo.

## What this repo is
GitHub-native design review for AI-generated frontend PRs. pnpm + TypeScript
monorepo, strict TS (NodeNext ESM, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`,
`import type`, `.js` import extensions). Two delivery paths: the **Action path**
(`@gate/action`, runs in a GitHub runner) and the **App path** (`@gate/service`,
hosted Fastify webhook orchestrator). Capture + critique are the **judgment-engine**
(separate repo); Gate is **judgment-only**.

## Hard rules (non-negotiable)
- **Never `contents: write`** and never edit customer code. Gate posts comments +
  Check Runs only. `assertNoContentsWrite` guards this; keep it green.
- **No BYOK.** No real model / sandbox / live network in tests — use stubs/fakes
  and the golden wire fixture (`@gate/types`), which must stay byte-compatible
  with judgment-engine's copy.
- **Boundaries:** Action path must NOT depend on `@gate/service` (sibling, App
  path). Shared code lives lower (`@gate/engine`/`@gate/types`/`@gate/config`).
- **No AI attribution** in commits/PRs/issues/comments.

## Build & verify (run all before committing)
```
pnpm install
pnpm typecheck   # tsc -b (project references)
pnpm test        # vitest (PGlite for DB; in-memory fakes elsewhere)
pnpm lint        # eslint . --max-warnings=0
```

## PR discipline
One PR per milestone/feature, not one ever-growing PR (see `LOOP.md`). For a
multi-part feature like #70 below, one PR per Part, each green on its own.

---

# Active focused work: #70 — preview-command local server supervision

Full spec (design + rationale + AC + test plan) is the pinned comment on
`apatureai/gate#70`. This section is the authoritative implementation plan: the
language decision and the ordered Part breakdown. Implement Parts in order; each
is a coherent, independently-tested PR.

## Decision record

**DR-1 Language = TypeScript/Node (not Go/Rust).** The supervisor runs in-process
inside the Node Action and integrates with injected TS deps. Node exposes the
needed POSIX primitives directly (`spawn({detached:true})`, `process.kill(-pgid,
sig)`, `process.on('SIGTERM')`). A Go/Rust binary would add a cross-language
boundary + an extra process layer that makes the no-orphan guarantee *harder*,
and the ephemeral runner already bounds orphan lifetime. Go/Rust would be correct
for a standalone long-lived supervisor daemon (e.g. the engine's microVM fleet),
which this is not.

**DR-2 PID-1 init in the Action Docker image.** The real systems-robustness win
is language-agnostic: run an init process (tini / Docker `init: true`) as PID 1 so
SIGTERM is forwarded to the action and zombies are reaped. Add this to the Action
Dockerfile (Part 5).

**DR-3..8** = the debate-locked design decisions D1–D6 (readiness = first HTTP
status < 500; failure-only secret-scrubbed Check Run tail; SIGTERM→5s→SIGKILL
process-group teardown with liveness guard; run fork code contained + split
same-repo vs fork behind a default-off `fork_preview`; reuse + hoist
`waitForReadiness` to `@gate/engine` with `abortOnChildExit`; process-group +
stripped env + ceiling, no containerize). See the issue spec for rationale.

## Parts (implement in order)

### Part 1 — hoist `waitForReadiness` to `@gate/engine` + `abortOnChildExit`
- Move `waitForReadiness` (+ `ReadinessResult`/`ReadinessOptions`) from
  `@gate/service/src/readiness.ts` to `@gate/engine`; re-export from `@gate/service`
  for back-compat (no behavior change to existing App-path callers).
- Extend options with `abortOnChildExit?: () => boolean` (or an extra `AbortSignal`)
  so the loop short-circuits when the spawned child has exited, instead of polling
  a dead port to the ceiling.
- Verified safe: `@gate/engine` does not depend on `@gate/service` (no cycle);
  nothing but `service`/`e2e` import `service`.
- Tests: move `readiness.test.ts`; add an early-exit short-circuit case. AC: green
  typecheck/test/lint; App-path behavior unchanged.

### Part 2 — `fork_preview` config field
- Add `fork_preview` (bool, default `false`) to the `.designreview.yml` Zod schema
  in `@gate/config`; expose normalized as `config.preview.forkPreview`.
- Tests: default false; parses true; snake_case normalization. AC: schema + type
  + tests green. Independent of Part 1.

### Part 3 — `local-serve.ts` supervisor (the core)
- New `packages/action/src/local-serve.ts`:
  `startLocalServer(command, { url, ceilingMs=120_000, graceMs=5_000, env, cwd, spawnImpl?, fetchImpl?, now?, sleep? })`
  → `{ ok:true; server } | { ok:false; reason:"spawn_failed"|"early_exit"|"not_ready"; detail }`;
  `LocalServerHandle = { url; stop():Promise<void> }` (idempotent).
- spawn `{ shell:true, detached:true, cwd, env:<allowlist>, stdio:["ignore","pipe","pipe"] }`;
  drain stdout/stderr into a bounded ~16KB ring buffer (continuous, never blocks).
- env allowlist: PATH/HOME/cwd/NODE_ENV/CI + standard runner vars; NEVER
  `JUDGMENT_ENGINE_API_KEY`, `JUDGMENT_ENGINE_HMAC_SECRET`, `GITHUB_TOKEN`, storageState.
- readiness: use the Part-1 poller; ready = first HTTP response status < 500;
  check child-exit each iteration first (→ early_exit); `child.on('error')` → spawn_failed.
- stop(): SIGTERM → wait `graceMs` (unref'd timer) → if group still alive
  (`kill(-pgid,0)`) SIGKILL; clear timer on child exit; swallow ESRCH; idempotent.
- Tests (REAL fixture node processes, localhost only): ready, early_exit, not_ready,
  orphan/process-group (child-of-child both dead after stop), grace→SIGKILL (fixture
  traps SIGTERM), env-isolation, readiness-semantics (401/302 ready, 503 not).
  Deterministic via injected `now`/`sleep`/short `ceilingMs`/`graceMs`; each test
  awaits real process death. Depends on Part 1.

### Part 4 — wire into `runAction` (fork gate + teardown + failure mapping)
- Inject `deps.startLocalServer`. After `verifyPreviewHandoff`, when
  `source === "local"`: if `ctx.isFork && !config.preview.forkPreview` → neutral
  "Preview skipped on fork" Check Run (no spawn); else `startLocalServer`; on
  failure → neutral not-reviewed Check Run with a secret-scrubbed (`@gate/secrets`
  `redact()`), length-capped, fenced+labeled tail (current-head guarded); on
  success run the review inside `try { ... } finally { await server.stop() }`.
- Tests with a fake `startLocalServer`: spawns only on local source; fork gate
  on/off; failure → neutral + tail, no engine call; success → review + teardown
  called; higher-priority source → no spawn. Depends on Parts 2 + 3.

### Part 5 — `main.ts` wiring + Dockerfile init + README
- `main.ts`: construct the real `startLocalServer`, register `SIGINT`/`SIGTERM`
  handlers that call `stop()` (Action-path supersession = job cancel = SIGTERM),
  pass the env allowlist + repo cwd.
- Dockerfile: PID-1 init (DR-2).
- README: `preview-command` minimal example + readiness/cleanup/fork behavior.
- Depends on Part 4. (`main.ts` is the ops entrypoint; light/no unit coverage.)

### Out of scope → file as a separate follow-up issue
- cgroup/ulimit pids+mem cap on the spawned server (D6 availability gap).
- Configurable ready-path/expected-status (D1 enhancement).
- Windows runner support (Action is a Linux container; teardown is POSIX).
