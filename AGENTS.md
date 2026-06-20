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

**DR-3..8** = the debate-locked design decisions D1–D6 (readiness; failure-only
secret-scrubbed Check Run tail; SIGTERM→5s→SIGKILL process-group teardown with
liveness guard; run fork code contained + split same-repo vs fork behind a
default-off `fork_preview`; reuse + hoist `waitForReadiness` to `@gate/engine`
with `abortOnChildExit`; process-group + stripped env + ceiling, no containerize).
See the issue spec for rationale.

**DR-9 Use `execa` for spawn + teardown — do not hand-roll signals/timers.**
`execa` is the de-facto Node process library; its `forceKillAfterDelay` defaults
to **5s** (SIGTERM→SIGKILL, exactly D3) and `cleanup:true` kills the child when
the parent exits. We still spawn `detached:true` and group-kill (`-pgid`) for the
*tree* (execa/`ChildProcess.kill` only signals the direct child). The
injected-`spawnImpl` seam stays for tests. Rationale: the SIGTERM→SIGKILL
escalation and parent-exit cleanup are subtle and library-hardened — the MCP
TypeScript SDK shipped an orphan bug doing this by hand. The load-bearing
correctness fact (industry-confirmed): **a detached child is NOT auto-killed when
the parent exits normally** — so teardown on every path (`finally` + signal
handlers) + the tini PID-1 backstop (DR-2) is mandatory, not optional.

**DR-10 Readiness ready-status set = Playwright `webServer`'s exact set.** Ready =
an HTTP response with status in {2xx, 3xx, 400, 401, 402, 403} (this is what
Playwright's battle-tested `webServer` accepts). 404/405+/5xx and
connection-refused = not ready, keep polling to the ceiling. Supersedes the
looser "status < 500". Optional later enhancement: log-regex readiness (mirror
Playwright's 2025 `wait` field) for servers whose HTTP readiness lies.

## Industry-standard approaches & prior art (researched 2026-06-20)
We are NOT inventing process supervision; we mirror the hardened references and
borrow their tuning. What we take from each:
- **Playwright `webServer`** (closest analog — boots a server, waits, points a
  browser at it, tears it down): the **ready-status set** (DR-10), `detached`
  process-group teardown with a SIGKILL fallback, `reuseExistingServer:!CI`
  (always start fresh in CI), and the log-regex `wait` option (our optional
  enhancement). https://playwright.dev/docs/test-webserver
- **`execa`** (DR-9): `forceKillAfterDelay` (5s default = D3), `cleanup`,
  `detached`. The spawn/teardown engine. https://www.npmjs.com/package/execa
- **`start-server-and-test` / `wait-on`**: the canonical "start → wait → run →
  shut down" CLI/readiness pattern; the design reference for the overall flow.
  (Not adopted directly: they wrap a test *command*; our "test" is an in-process
  engine review, not a shell command.)
- **`tree-kill` / `execa-tree-kill`**: cross-platform tree teardown; only needed
  if Windows support is ever added (we're Linux-only, so `-pgid` group kill
  suffices). https://github.com/pkrumins/node-tree-kill
- **tini / dumb-init**: container PID-1 init for signal forwarding + zombie
  reaping (DR-2) — the standard Docker fix.

Known failure mode the references all warn about (and one shipped as a bug —
MCP TypeScript SDK #2023): a `close()`/teardown that signals only the direct
child leaves an orphan tree, and a `detached` child outlives a normally-exiting
parent. Our teardown-on-every-path + group kill + tini backstop is the answer.

## Unique differentiators (beyond the standard)
Playwright/execa/start-server-and-test all treat the dev server as an **opaque box
to wait on, then kill**. Gate is the only one of these that (a) spawns the server
specifically to feed a **vision-model design review** and (b) runs **untrusted
fork code**. Those two facts unlock two things no standard tool does. This is the
layer that makes #70 ours, not a reimplementation.

**U1 — the supervisor is a REVIEW SIGNAL SOURCE, not just a launcher (headline).**
We already capture the preview-command's stdout/stderr (for the D2 diagnostics
tail). Parse it for structured build/runtime diagnostics — framework-agnostic
patterns: "Failed to compile", webpack/vite/next warnings, hydration mismatch
warnings, missing-asset / chunk-load errors, deprecation notices — and emit them
as `previewBuildFacts` on the `GateReviewRequest`. The hosted engine then grounds
the critique in the **build's own truth**, not just pixels: a hydration warning, a
404'd font, or a failed CSS build is a design-quality signal a VLM would otherwise
have to infer (or miss) from a screenshot. No standard tool does this because no
standard tool is feeding a design reviewer. Marginal cost is low (we parse output
we already buffer). Wire impact: additive field behind `x-schema-version`, golden
fixture stays byte-compatible; the **engine consuming it is a judgment-engine
change** (cross-repo dep) — Gate attaches the facts now, the engine uses them when
ready. This is the differentiator; prioritize it.

**U2 — defend the hosted reviewer against a hostile fork server (unique security
edge).** Standard `webServer` tools follow redirects blindly. We point a *hosted
engine* at a server *the fork controls*. A fork's dev server can 3xx the readiness
probe (or the engine) to a non-loopback host to exfiltrate or to steer the engine
at attacker infra. So: the readiness probe **does not follow redirects**, and a
3xx whose `Location` is non-loopback ⇒ refuse handoff (not_ready + a clear
"preview redirected off localhost" reason), not a silent follow. Complements the
existing loopback-only `verifyPreviewHandoff` (which only checks the initial URL,
not runtime redirects) and the env allowlist. Cheap, on-domain, and no standard
tool bothers because none of them are pointing a privileged agent at untrusted
code. Fold into Part 3.

**Considered and rejected (honesty over novelty):** adaptive readiness ceiling
tied to review depth (real but premature — the engine short-circuits triage
anyway); per-repo boot-time "taste memory"/caching hints (DX sugar, not core);
cgroup/eBPF honeypot for a misbehaving fork server (the D6 availability gap — real
but over-engineering for the wedge, already a follow-up).

## Parts (implement in order)

### Part 1 — hoist `waitForReadiness` to `@gate/engine` + `abortOnChildExit`
- Move `waitForReadiness` (+ `ReadinessResult`/`ReadinessOptions`) from
  `@gate/service/src/readiness.ts` to `@gate/engine`; re-export from `@gate/service`
  for back-compat (no behavior change to existing App-path callers).
- Extend options with `abortOnChildExit?: () => boolean` (or an extra `AbortSignal`)
  so the loop short-circuits when the spawned child has exited, instead of polling
  a dead port to the ceiling.
- Make the ready predicate injectable: `acceptStatus?: (status:number)=>boolean`,
  **default = strict 200** so the App path is unchanged; the Action path (Part 3)
  passes the Playwright set {2xx,3xx,400,401,402,403} (DR-10). This keeps Part 1 a
  behavior-preserving refactor.
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
- spawn via **execa** (DR-9): `{ shell:true, detached:true, cwd, env:<allowlist>,
  cleanup:true, forceKillAfterDelay:graceMs, stdio:["ignore","pipe","pipe"] }`.
  Drain stdout/stderr into a bounded ~16KB ring buffer (continuous, never blocks).
  Injected `spawnImpl` defaults to execa; tests pass a fake/fixture spawner.
- env allowlist: PATH/HOME/cwd/NODE_ENV/CI + standard runner vars; NEVER
  `JUDGMENT_ENGINE_API_KEY`, `JUDGMENT_ENGINE_HMAC_SECRET`, `GITHUB_TOKEN`, storageState.
- readiness: use the Part-1 poller; ready = HTTP status in {2xx,3xx,400,401,402,403}
  (DR-10); check child-exit each iteration first (→ early_exit); spawn error → spawn_failed.
- **U2 hostile-redirect guard:** probe with `redirect:"manual"` (never follow). A
  3xx whose `Location` resolves off-loopback ⇒ fail with the distinct
  `redirected_off_loopback` reason (its own Check Run message), not a silent
  follow and not a generic `not_ready`. Defends the hosted engine from a fork
  steering it off-box.
- stop(): group-kill the tree (`process.kill(-pgid,'SIGTERM')`) → execa's
  forceKillAfterDelay/own escalation handles SIGKILL after `graceMs`; before any
  manual SIGKILL re-check group liveness (`kill(-pgid,0)`); swallow ESRCH;
  idempotent. (Group kill because execa/`.kill()` only signals the direct child.)
- Tests (REAL fixture node processes, localhost only): ready, early_exit, not_ready,
  orphan/process-group (child-of-child both dead after stop), grace→SIGKILL (fixture
  traps SIGTERM), env-isolation, readiness-semantics (401/302 ready, 503 not).
  Deterministic via injected `now`/`sleep`/short `ceilingMs`/`graceMs`; each test
  awaits real process death. Depends on Part 1.
- Adds `execa` to `@gate/action` deps (ESM-only, fits NodeNext). Update the
  pnpm lockfile; CI installs `--frozen-lockfile`.

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

### Part 6 — build-signal facts (U1, the differentiator)
- New pure `parsePreviewBuildFacts(output: string): PreviewBuildFact[]` in
  `@gate/action` (or `@gate/engine` if shared): framework-agnostic regex/heuristics
  over the captured ring-buffer output → structured facts
  `{ kind:"compile_error"|"warning"|"asset_error"|"hydration"|"deprecation", message, source? }`,
  deduped + capped.
- Add `previewBuildFacts?: PreviewBuildFact[]` to `GateReviewRequest` in
  `@gate/types` — **additive, behind `x-schema-version`; golden fixture unchanged**.
  `runAction` attaches the facts from Part 3's output to the engine request.
- The engine *consuming* these facts to ground the critique is a **judgment-engine
  issue** (cross-repo): tag `[judgment-engine #N]`. Gate emits now; engine uses
  when implemented. Until then the field is carried and ignored (no harm).
- Tests: pure-parser table tests (real Vite/Next/webpack output fixtures →
  expected facts); `runAction` attaches facts when present; absent on non-local /
  no-output paths. Depends on Part 3 (the output buffer). Independent of 4/5.

### Out of scope → file as a separate follow-up issue
- cgroup/ulimit pids+mem cap on the spawned server (D6 availability gap).
- Configurable ready-path/expected-status (D1 enhancement).
- Windows runner support (Action is a Linux container; teardown is POSIX).

## Implementation-ready details (so "start building" is zero-ambiguity)

### Types (exact)
```ts
// packages/action/src/local-serve.ts
export type LocalServerReason =
  | "spawn_failed"            // command never started (ENOENT, bad shell)
  | "early_exit"             // started then exited before ready
  | "not_ready"              // ceiling hit, never an accepted status
  | "redirected_off_loopback"; // U2: probe 3xx Location left loopback

export interface LocalServerHandle { url: string; pid: number; stop(): Promise<void>; } // stop() idempotent
export type LocalServerStartResult =
  | { ok: true; server: LocalServerHandle }
  | { ok: false; reason: LocalServerReason; detail: string; tail?: string };

export interface StartLocalServerOptions {
  url: string; cwd: string; env: Record<string, string>;
  ceilingMs?: number;   // default 120_000
  graceMs?: number;     // default 5_000 (== execa forceKillAfterDelay default)
  pollIntervalMs?: number; // default 2_000
  spawnImpl?: SpawnFn;  // default execa; tests inject a fake/fixture
  fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
}
```

### Child env — allowlist (default-deny), exact keys
Pass ONLY: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM`, `CI`, `GITHUB_WORKSPACE`,
`RUNNER_OS`, `RUNNER_TEMP`, `NODE_ENV` (pass-through if set). Everything else dropped.
Never pass `JUDGMENT_ENGINE_API_KEY`, `JUDGMENT_ENGINE_HMAC_SECRET`, `GITHUB_TOKEN`,
`INPUT_*`, or anything matching `/(_SECRET|_TOKEN|_KEY|PASSWORD)$/i`. Implement as an
allowlist, not a denylist, so a new secret env var can never leak by omission.

### U1 wire type (`@gate/types`, additive)
```ts
export type PreviewBuildFactKind = "compile_error" | "warning" | "asset_error" | "hydration" | "deprecation";
export interface PreviewBuildFact { kind: PreviewBuildFactKind; message: string; source?: string; }
// GateReviewRequest gains:  previewBuildFacts?: PreviewBuildFact[]   (optional → golden fixture byte-unchanged)
```
Engine must parse the request with the field optional/passthrough (Zod `.optional()` /
passthrough). Consuming it = `[judgment-engine #N]`; until then carried + ignored.

### Failure → Check Run copy (neutral, current-head guarded; tail is redact()'d + fenced, failure-only)
- spawn_failed → "Preview not started — `preview-command` failed to launch."
- early_exit → "Preview server exited before it was ready (exit N). Not reviewed."
- not_ready → "Preview server did not respond at <url> within <ceiling>s. Not reviewed."
- redirected_off_loopback → "Preview redirected off localhost (<host>); refused for safety."
- fork gate → "Local preview is disabled for fork PRs; set `fork_preview: true` to enable."

### Test matrix (vitest names)
Part 3 `local-serve.test.ts`: ready / early_exit / not_ready / redirected_off_loopback /
orphan-process-group-both-dead / grace→SIGKILL (SIGTERM-trapping fixture) / env-isolation /
ready-status-set (401,302 ready; 404,503 not). Part 4 `run.test.ts`: spawns-only-on-local /
fork-gate-off-skips / fork-gate-on-spawns / failure→neutral+tail+no-engine-call /
success→review+teardown / higher-priority-source→no-spawn. Part 1: existing readiness tests +
early-exit-short-circuit + acceptStatus-default-200. Part 6 `build-facts.test.ts`: Vite/Next/
webpack output fixtures → expected facts; runAction attaches when present.

### Per-part size + definition of done
- P1 hoist+predicate+abortOnChildExit — **S** — DoD: green; App-path readiness behavior identical.
- P2 fork_preview config — **XS** — DoD: schema+type+default-false tested.
- P3 local-serve supervisor — **L** (the core) — DoD: all 8 fixture tests green; no orphan/leak in any.
- P4 runAction wiring — **M** — DoD: fork gate + teardown + failure mapping tested with a fake supervisor.
- P5 main.ts + Dockerfile init + README — **M** — DoD: `next`-free; signal handlers wired; README section.
- P6 build-facts (U1) — **M** — DoD: parser table-tested; additive wire field; golden unchanged; engine dep filed.

### Risk register (all mitigated in-design)
- Detached child survives a normally-exiting parent → teardown on every path (finally+signals) + tini PID-1 (DR-2).
- Pipe buffer deadlock on a chatty server → continuous ring-buffer drain.
- PID reuse between SIGTERM and SIGKILL → only KILL if not-exited + `kill(-pgid,0)` liveness check.
- `waitForReadiness` move regresses App path → injectable `acceptStatus` default-200 + re-export.
- Fork ACE → env allowlist + loopback-only + ephemeral runner + fork opt-in (contained, not eliminated).
- Cross-repo wire field → optional/additive; engine tolerates; golden fixture byte-unchanged.
