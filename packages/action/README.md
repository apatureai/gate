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

## Security: hostile-PR capture

On the Action path, capture runs in **your** runner, so hostile PR code executes
in the capture browser and can probe runner-internal networks. **Do not run on
`pull_request_target` with secrets in scope.** `storageState`/auth and
preview-bypass secrets are disabled automatically on fork PRs. For untrusted
forks, prefer the App path (engine-sandboxed capture). Full analysis:
[docs/threat-model-action-path.md](../../docs/threat-model-action-path.md).
