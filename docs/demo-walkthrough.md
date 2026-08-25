Part of [gate](../README.md). Moved from the README on 2026-08-24; anchors preserved.

### The sandbox supervisor

`pnpm demo` points the supervisor at a fixture app in `packages/action/fixtures/` that forks two child workers, one of which traps `SIGTERM` and refuses to die, then reports what the supervisor did to it.

```bash
pnpm demo
```

```
Gate sandbox supervisor demo
platform darwin · node v24.14.0 · shell /bin/sh (platform default)

[1/4] supervised start and process-group teardown
  command       node "./packages/action/fixtures/preview-app.mjs" serve
  ready         http://127.0.0.1:63725 in 181 ms (pid 14814, process group 14814)
  GET /         200 · Gate fixture preview app
  build facts   1 parsed from the dev-server log
                hydration: preview-app: Warning: Hydration failed because the server-rendered HT…
  process group 3 processes before stop()
                  14814  node ./packages/action/fixtures/preview-app.mjs serve
                  14815  node ./packages/action/fixtures/preview-worker.mjs well-behaved
                  14816  node ./packages/action/fixtures/preview-worker.mjs stubborn
  stop()        SIGTERM to the group → 2000 ms grace → SIGKILL to whatever survived
                +    0 ms  3 left  (preview-app.mjs serve; preview-worker.mjs well-behaved; preview-worker.mjs stubborn)
                +   54 ms  1 left  (preview-worker.mjs stubborn)
                + 2106 ms  0 left
  result        group gone after 2106 ms · orphans: 0

[2/4] environment allowlist
  offered       GITHUB_TOKEN, GATE_ENGINE_API_KEY, GATE_ENGINE_HMAC_SECRET (fake runner secrets)
  passed in     HOME, LANG, PATH, TERM, TMPDIR
  child saw     HOME, LANG, PATH, PORT, PWD, SHLVL, TERM, TMPDIR, _, __CF_USER_TEXT_ENCODING  (PORT comes from the supervisor caller, PWD/SHLVL/_ from the shell)
  leaked        none

[3/4] resource cap
  limits        512 processes, 4096 MiB address space
  spawned as    node "./packages/action/fixtures/preview-app.mjs" serve
  applied       no — the ulimit prologue is Linux-only, this is darwin
  on Linux      ulimit -u 512 2>/dev/null; ulimit -v 4194304 2>/dev/null; node "./packages/action/fixtures/preview-app.mjs" s…
  child reports max processes:   soft 2666, hard 4000
                address space:  soft unlimited, hard unlimited

[4/4] off-loopback redirect refused
  fixture       302 → https://preview.attacker.example/pwn
  supervisor    redirected_off_loopback: preview redirected to preview.attacker.example

PASS — fixture app served, contained, and torn down with no orphaned processes.
```

**Success looks like:** the last line reads `PASS`, the teardown census ends in `0 left`, `orphans: 0`, and `leaked  none`. Exit code 0. Ports, pids and timings will differ.

If it fails: `Error: Cannot find module` means the build did not run, so use `pnpm demo` rather than invoking `dist/` directly. A `not_ready` failure means something else grabbed the port the fixture picked; rerun.

### Seeing the resource cap actually bite (optional, needs Docker)

The `ulimit` prologue is Linux-only (`ulimit -v` is unsupported on macOS), so on a Mac the demo honestly reports `applied  no`. To watch the kernel enforce it, run the same built CLI on Linux. `pnpm demo` above already produced `dist/`, and Docker must be allowed to share the repository's path:

```bash
docker run --rm -v "$PWD":/repo -w /repo node:24-slim \
  node packages/action/dist/supervisor-demo-cli.js
```

```
Gate sandbox supervisor demo
platform linux · node v24.19.0 · shell /bin/bash
...
  stop()        SIGTERM to the group → 2000 ms grace → SIGKILL to whatever survived
                +    0 ms  3 left  (preview-app.mjs serve; preview-worker.mjs well-behaved; preview-worker.mjs stubborn)
                +   56 ms  1 left  (preview-worker.mjs stubborn)  +1 zombie
                + 2076 ms  0 left  +2 zombie
  result        group gone after 2086 ms · orphans: 0
                2 zombie pid(s) await reaping — this process is PID 1 here and reaps nothing;
                a CI runner's init does. They run no code.
...
[3/4] resource cap
  limits        512 processes, 4096 MiB address space
  spawned as    ulimit -u 512 2>/dev/null; ulimit -v 4194304 2>/dev/null; node "./packages/…
  applied       yes
  child reports max processes:   soft 512, hard 512
                address space:  soft 4294967296, hard 4294967296
```

Two things to read there. The child's own rlimits now match the cap, so the kernel is enforcing it, and the shell line says `/bin/bash`, which is what makes `ulimit -u` take effect at all. And the killed processes linger as zombies, because in a bare container this process is PID 1 and reaps nothing; a zombie holds a pid but runs no code, so it is reported separately from an orphan. (`node:24-slim` ships no `ps`; the census falls back to reading `/proc`.)


### A design review, end to end

`pnpm demo:review` runs the Action path's review orchestration against a **recorded** critique (the golden fixture in `packages/types/fixtures/`) and writes what a pull request would have received.

```bash
pnpm demo:review
```

```
Gate review demo (recorded engine response, no model call, no network)

  PR              example-org/gate-demo#7 @ 0123456
  engine result   needs_work · 3 findings · 2 areas not reviewed
  action status   reviewed · comment created
  check run       neutral — Needs work

  wrote
    ./out/review-comment.md  (1260 bytes — the sticky PR comment, verbatim)
    ./out/check-run.json  (the Check Run payload)
    ./out/annotated-f_001.png  (26154 bytes — finding f_001 boxed on the fixture page)
    ./out/annotated-f_002.png  (26878 bytes — finding f_002 boxed on the fixture page)
```

**Success looks like:** four files in `out/`. `out/review-comment.md` opens with the hidden sticky marker `<!-- apature-gate:sticky -->` and lists *"Primary CTA uses an off-brand color on mobile"*. It shows a grade because the golden fixture carries `provenance.model_backed: true`, which is what a critique service stamps on a result a model actually produced; strip that block out of the fixture and the same command writes a *Judgment not stated* Check Run with no grade instead. `out/annotated-f_001.png` is a 390x844 fixture pricing page with a red box drawn around the call-to-action button and the label `f_001 CTA off-palette`, byte-identical to [the committed copy](assets/gate_review_demo.png). Regenerate that copy with `cp out/annotated-f_001.png docs/assets/gate_review_demo.png`.

What is real in that run: `runAction`, the engine client and its schema checking, finding validation and degradation, the sticky-comment renderer, the Check Run mapping, and `annotateScreenshot`'s SVG compositing. What is substituted: the engine's HTTP responses (replayed), the base screenshot (drawn locally from an SVG), and the element geometry the boxes come from (a real run gets it from the engine's capture geometry map). Nothing in the demo judges a UI; it replays a recorded judgment through the real delivery path.

Both demos are covered by the test suite (`packages/action/test/supervisor-demo.test.ts`, `packages/action/test/review-demo.test.ts`), so they cannot rot silently while the tests stay green.


### Running your own critique service, and pointing Gate at it

The previous demo replays a recorded critique. This one runs the whole chain against a critique service that is genuinely running on your machine: real HMAC signing, a real `POST /jobs`, a real headless-Chromium capture of a page the sandbox supervisor really started, and the real schema check on the way back. Only GitHub is substituted, because publishing to a pull request needs an account and proves nothing about whether the two halves agree.

**One terminal for the engine.** [`verdict`](https://github.com/apatureai/verdict) is the reference implementation of the contract:

```bash
git clone https://github.com/apatureai/verdict.git && cd verdict
pnpm install --frozen-lockfile
pnpm browser:install          # downloads the Chromium the capture needs
pnpm build

export ENGINE_HMAC_SECRET="$(openssl rand -hex 32)"   # required; never defaulted
node packages/serve/dist/main.js --port 8791 --model mock
```

```
judgment-engine-serve listening on http://127.0.0.1:8791
  MOCK model client — deterministic, empty critique. No network call.
  no model is configured, so every result will carry provenance saying nothing judged the page
  artifacts: out/serve
  POST /jobs to submit, GET /jobs/:id to poll, DELETE /jobs/:id to cancel
```

**A second terminal for Gate**, with the same secret:

```bash
cd gate
export GATE_ENGINE_ENDPOINT=http://127.0.0.1:8791
export GATE_ENGINE_HMAC_SECRET=<the same value you exported above>
export GATE_LOCAL_SERVE_URL=http://127.0.0.1:3311
pnpm demo:live
```

```
Gate live review (real engine, real capture, GitHub substituted)

  engine          http://127.0.0.1:8791
  preview         http://127.0.0.1:3311  (fixture app, started by the supervisor)
  action status   not_judged · comment created
  check run       neutral, Not judged
  judgment        unjudged: NOTHING judged the page; the engine has no model configured, and Gate withheld the grade
  coverage        full: every requested route and viewport was reviewed

  wrote
    ./out/live-review-comment.md  (the sticky PR comment, verbatim)
    ./out/live-check-run.json  (the Check Run payload)
```

`GATE_ENGINE_API_KEY` is optional and left unset above: a self-hosted engine authenticates on the HMAC signature alone. Set it if your service also wants a bearer token.

**That "Not judged" is the point, not a failure.** The engine above has no model key, so it captured the page for real, measured contrast, overflow and touch targets for real, and then filled the critique from a deterministic stand-in. The result it returned still carries `grade: "ship"`, because a wire result always carries a grade. Gate reads the engine's `provenance` stamp, sees `model_backed: false`, and refuses to let that grade speak: the Check Run is neutral and titled *Not judged*, and the comment leads with the disclosure instead of a green badge. Nothing in this repository will show you a ✅ for a page nothing looked at.

Give the engine a model and the same command produces a review:

```bash
# in the engine's terminal
export MODEL_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1   # or your vLLM/SGLang endpoint
export MODEL_API_KEY=<your key>
node packages/serve/dist/main.js --port 8791 --model live
```

```
  action status   reviewed · comment created
  check run       neutral, Needs work
  judgment        model_backed: a model judged the page; the grade above is a review
  coverage        full: every requested route and viewport was reviewed
```

and `out/live-review-comment.md` is a real review of the fixture page, with each finding linked to the screenshot region it came from:

```markdown
## Apature Gate: design review

**⚠️ Needs work** · reviewed `0123456`

The page has one heading and no visual hierarchy below it.

<details>
<summary>Should fix (1)</summary>

- **Heading sits at default browser size** (`/`, desktop). Apply the design system's display type token to the h1. · [Evidence](http://127.0.0.1:8791/artifacts/jobs/.../screenshots/index/desktop.png?token=...)

</details>
```

With no engine configured at all, `pnpm demo:live` refuses before touching the network and exits 2:

```
No engine to review against. Set GATE_ENGINE_ENDPOINT and GATE_ENGINE_HMAC_SECRET.
```

**With the wrong shared secret**, which is the mistake to expect, the same command reaches the service, is rejected, and says which variable is wrong:

```
[gate] engine call failed (engine_rejected): engine submit failed: 401 (signature_mismatch)

  action status   engine_rejected · comment none
  check run       neutral, Review not submitted
```

`out/live-check-run.json` carries what the pull request would have shown:

```
Gate reached the critique service, and the service rejected the request. No review was
submitted and the PR is not blocked.

The critique service answered `HTTP 401 signature_mismatch`.

`GATE_ENGINE_HMAC_SECRET` does not match the critique service's own `ENGINE_HMAC_SECRET`.
The two values have to be identical.

This one does not clear by itself: the next push sends the same request to the same
endpoint with the same credentials, so Gate is not promising a retry that would fix it.
```

**With a preview that redeployed at a new URL under an unchanged head SHA**, the idempotency key for that `(pr, head_sha)` has already been spent on a different request body, so the service answers `409 idempotency_conflict` and Gate gives it its own Check Run rather than calling it an outage:

```
[gate] engine call failed (idempotency_conflict): engine submit conflict: idempotency_conflict (the idempotency key is already in use by a different request)

  action status   idempotency_conflict · comment none
  check run       neutral, Review not submitted (duplicate key)
```

Its summary names the cause and the remedy: push a commit, or re-run once the preview URL has settled. Neither of these two ever fails the pull request, and neither pretends a retry will help.

Once that command works, the same two variables are what the workflow needs; see [Using the Action in a workflow](../README.md#using-the-action-in-a-workflow). `demo:live`'s refusal path and its transcript are covered by `packages/action/test/live-review.test.ts`; its happy path needs a running engine and a browser, so it is exercised by hand and the transcripts above are from those runs.


### Running the Action locally

The Action's entrypoint (`packages/action/src/main.ts`) reads its inputs from the runner environment, so it can be driven by hand: build the image and give it an event payload.

Write the payload **inside the repository working directory**, not `/tmp`. Docker Desktop on macOS shares only a fixed set of host paths (`/Users` among them, `/tmp` and `/private/tmp` not). A bind mount of an unshared path silently becomes an empty *directory* inside the container, and the Action then dies on `EISDIR`. If your clone is under your home directory, `$PWD` is shared; if you cloned somewhere exotic, add that path under Docker Desktop → Settings → Resources → File sharing. One command tells you which you have, and it must print a file, not a directory listing:

```bash
docker run --rm -v "$PWD/README.md":/tmp/probe node:24-slim ls -la /tmp/probe
```

```bash
docker build -f Dockerfile.action -t gate-action .
cat > ./event.json <<'JSON'
{"pull_request":{"number":7,"title":"Refresh the pricing page","body":null,
 "head":{"sha":"0123456789abcdef0123456789abcdef01234567","repo":{"full_name":"acme/web"}},
 "base":{"sha":"fedcba9876543210fedcba9876543210fedcba98","repo":{"full_name":"acme/web"}}}}
JSON
docker run --rm -v "$PWD/event.json":/tmp/event.json \
  -e GITHUB_REPOSITORY=acme/web \
  -e GITHUB_EVENT_PATH=/tmp/event.json \
  -e INPUT_PREVIEW_URL=https://acme-web-pr7.vercel.app \
  -e INPUT_GITHUB_TOKEN=<a token with checks:write and pull-requests:write> \
  -e GATE_ENGINE_ENDPOINT=<your critique service base URL> \
  -e GATE_ENGINE_API_KEY=<your key> \
  -e GATE_ENGINE_HMAC_SECRET=<your HMAC secret> \
  gate-action
```

**What you get depends on the token.** The angle-bracketed values are placeholders, so the command is not runnable as printed.

- **With no valid `INPUT_GITHUB_TOKEN`**, the first GitHub call fails and you see one line, then exit 0:

  ```
  Apature Gate action error: list comments failed: 401
    GitHub rejected the token. Set INPUT_GITHUB_TOKEN (or GITHUB_TOKEN) to a token with checks:write and pull-requests:write. Nothing was published; the run still exits 0 so the pull request is not failed.
  ```

  GitHub is contacted before the critique service, so no Check Run is published and the service is never reached. Exit 0 still holds (a broken reviewer never fails someone's pull request), but nothing is delivered.
- **With a real token on a real pull request and no reachable service**, the run exits 0 after logging an error and publishing a neutral Check Run.

That is the honest local story for the full Action: it is a thin wrapper whose two dependencies (GitHub and the critique service) are both remote, so running it by hand needs at least one of them for real. To exercise the orchestration itself with neither, use `pnpm demo:review`, which drives the same `runAction` function.

