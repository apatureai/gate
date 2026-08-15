# @gate/action

The Gate **Action path**: a zero-infra GitHub Action that resolves a PR preview
URL, submits a review job to the critique service you configure through
`GATE_ENGINE_ENDPOINT` (the public `verdict` being one), and posts a
sticky comment + advisory Check Run. No critique service ships in this
repository; with none configured the run ends in a neutral "Engine not
configured" Check Run naming the variables to set, and reviews nothing.
Judgment-only: it never requests `contents: write`.

Two variables are required and neither is defaulted: `GATE_ENGINE_ENDPOINT` and
`GATE_ENGINE_HMAC_SECRET`, which must equal the service's own
`ENGINE_HMAC_SECRET` because every job request is signed. `GATE_ENGINE_API_KEY`
is optional, for a service that also wants a bearer token.

**A run nothing judged is never published as a pass.** A critique service with
no model configured still returns a complete result carrying a grade. `runAction`
reads the service's `provenance` stamp and, unless it says a model judged the
capture, returns status `not_judged`, publishes a neutral *Not judged* Check Run,
and renders a comment that leads with the disclosure instead of a grade.

**A result that says nothing about its own judgment is treated the same way.** A
service that omits `provenance` entirely gets a neutral *Judgment not stated*
Check Run, not a green one. If you are writing a critique service, stamp
`provenance: { model_backed: true, source: "model", engine, model, detail }` on
results a model actually produced; that one additive field is the whole
difference between a graded review and a withheld one, and the Check Run names
it.

The part that needs no service at all is the local-serve supervisor documented
below; `pnpm demo` exercises it from a clean clone. To drive the whole chain
against a service you are running, `pnpm demo:live` (root
[README](../../README.md#running-your-own-critique-service-and-pointing-gate-at-it)).

## Usage

```yaml
permissions:
  contents: read        # NEVER contents: write
  pull-requests: write  # post the sticky comment
  checks: write         # post the Check Run

on: pull_request        # NOT pull_request_target (see security note)

jobs:
  design-review:
    runs-on: ubuntu-latest
    steps:
      - uses: apatureai/gate@v1
        with:
          preview-url: ${{ steps.deploy.outputs.preview-url }}
          # or: preview-command: "pnpm build && pnpm preview"
          config-path: .gate.yml
          gate-mode: none   # none | nits | blockers
        env:
          # Where your critique service listens, and the secret it verifies
          # signatures with (the same value as its own ENGINE_HMAC_SECRET).
          # Both are required, and neither is defaulted. Without them the step
          # publishes a neutral "Engine not configured" Check Run and reviews
          # nothing.
          GATE_ENGINE_ENDPOINT: ${{ secrets.GATE_ENGINE_ENDPOINT }}
          GATE_ENGINE_HMAC_SECRET: ${{ secrets.GATE_ENGINE_HMAC_SECRET }}
```

**Before you put this in CI, run [`pnpm demo:live`](../../README.md#running-your-own-critique-service-and-pointing-gate-at-it)
against the same endpoint and secret.** A workflow is a slow place to discover a
wrong shared secret. If one does reach CI, the step says so in words: the
critique service's rejection is published as a neutral *Review not submitted*
Check Run carrying its own `HTTP 401 signature_mismatch`, and it does not promise
a retry, because a wrong secret is not an outage and will not clear on the next
push.

## Local preview (`preview-command`)

When no hosted preview is found (no `preview-url`, no `url_template`, no
provider-bot comment) and `preview-command` is set, the Action **builds and
serves the PR locally** in the runner, then reviews that:

1. Spawns `preview-command` in its own process group.
2. Polls the local URL (default `http://127.0.0.1:3000`, override with
   `GATE_LOCAL_SERVE_URL`) until it responds. Ready means an HTTP status in
   `{2xx, 3xx, 400, 401, 402, 403}` (an auth-gated or redirecting dev server is
   "up"; the engine does the real in-page readiness check). Bounded by a 120s
   ceiling; a command that exits early or never responds is short-circuited.
3. Hands the verified `http://127.0.0.1:…` URL to the engine for review.
4. **Always tears the server down.** The whole process tree gets SIGTERM, then
   SIGKILL 5s later, on success, failure, timeout, or job cancellation. No
   orphans.

**Readiness tuning (`.gate.yml`):** by default the base URL is polled and
the status set above is accepted. Override per repo:

```yaml
preview:
  ready_path: /healthz      # poll this path instead of the base URL
  ready_status: [200]       # accept ONLY these status codes (stricter than the default set)
```

If the server fails to start / become ready, the review is skipped with a
neutral "Preview not ready" Check Run (the PR is never blocked). The raw command
output goes to the **Action log**; a **secret-scrubbed**, length-capped tail is
also attached to the Check Run (fenced, labeled untrusted) for quick triage.

**Forks:** local-serve runs the PR's own code, so on a fork (untrusted) it is
**disabled by default**. Set `preview: { fork_preview: true }` in
`.gate.yml` to opt in. The spawned server runs with an **allowlisted
env** (your runner secrets, engine keys and `GITHUB_TOKEN` among them, are never
passed to it), is loopback-only, and an off-localhost redirect is refused. On
**Linux** the child group is also resource-capped (`ulimit`: ≤512 procs, ≤4 GiB/proc by
default) so a fork-bomb or memory balloon can't wedge the runner before teardown;
the capped command runs under `/bin/bash` when it exists, because `/bin/sh` on
Debian/Ubuntu is dash and dash's `ulimit` has no `-u`.

## Running the supervisor by hand

The local-serve supervisor is demonstrable on its own, with no credentials and no
network beyond loopback. From the repository root:

```bash
pnpm demo        # spawn the fixture app in packages/action/fixtures, then tear the group down
pnpm demo:review # run the review orchestration against a recorded engine response
```

`pnpm demo` prints the process-group census before and during teardown (including
the worker that traps `SIGTERM` and has to be `SIGKILL`ed), the env the child
actually received, the rlimits it ran under, and the refusal of an off-loopback
redirect. See the root [README](../../README.md) for the annotated transcript.

## Security: hostile-PR capture

On the Action path, capture runs in **your** runner, so hostile PR code executes
in the capture browser and can probe runner-internal networks. **Do not run on
`pull_request_target` with secrets in scope.** `storageState`/auth and
preview-bypass secrets are disabled automatically on fork PRs. For untrusted
forks, prefer the App path (engine-sandboxed capture). Full analysis:
the "Threat model: Action-path hostile-PR capture" section of the
[root README](../../README.md).
