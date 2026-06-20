# @gate/action

The Apature Gate **Action path**: a zero-infra GitHub Action that resolves a PR
preview URL, submits a hosted `judgment-engine` review job, and posts a sticky
comment + advisory Check Run. Judgment-only — it never requests `contents: write`.

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
          config-path: .designreview.yml
          gate-mode: none   # none | nits | blockers
```

## Local preview (`preview-command`)

When no hosted preview is found (no `preview-url`, no `url_template`, no
provider-bot comment) and `preview-command` is set, the Action **builds and
serves the PR locally** in the runner, then reviews that:

1. Spawns `preview-command` in its own process group.
2. Polls the local URL (default `http://127.0.0.1:3000`, override with
   `GATE_LOCAL_SERVE_URL`) until it responds — ready = an HTTP status in
   `{2xx, 3xx, 400, 401, 402, 403}` (an auth-gated or redirecting dev server is
   "up"; the engine does the real in-page readiness check). Bounded by a 120s
   ceiling; a command that exits early or never responds is short-circuited.
3. Hands the verified `http://127.0.0.1:…` URL to the engine for review.
4. **Always tears the server down** — the whole process tree (SIGTERM → 5s →
   SIGKILL) on success, failure, timeout, or job cancellation. No orphans.

If the server fails to start / become ready, the review is skipped with a
neutral "Preview not ready" Check Run (the PR is never blocked); the raw
command output goes to the **Action log**, not the PR.

**Forks:** local-serve runs the PR's own code, so on a fork (untrusted) it is
**disabled by default**. Set `preview: { fork_preview: true }` in
`.designreview.yml` to opt in. The spawned server runs with an **allowlisted
env** (your runner secrets — engine keys, `GITHUB_TOKEN` — are never passed to
it), is loopback-only, and an off-localhost redirect is refused.

## Security: hostile-PR capture

On the Action path, capture runs in **your** runner, so hostile PR code executes
in the capture browser and can probe runner-internal networks. **Do not run on
`pull_request_target` with secrets in scope.** `storageState`/auth and
preview-bypass secrets are disabled automatically on fork PRs. For untrusted
forks, prefer the App path (engine-sandboxed capture). Full analysis:
[docs/threat-model-action-path.md](../../docs/threat-model-action-path.md).
