# Examples

## [`gate.yml`](gate.yml) — the primary adopter artifact

A complete, liftable GitHub Actions workflow that runs Apature Gate on every
pull request. Copy it to `.github/workflows/gate.yml` in your repository and set
the two secrets it names (`GATE_ENGINE_ENDPOINT`, `GATE_ENGINE_HMAC_SECRET`).
The file is annotated inline; the same walkthrough lives in the root README under
[Using the Action in a workflow](../README.md#using-the-action-in-a-workflow).

Gate is the GitHub-facing half of a two-part system: it hands a verified preview
URL to a critique service you host and publishes that service's review back to
the pull request. It never edits code and never requests `contents: write`.
[`apatureai/verdict`](https://github.com/apatureai/verdict) is a working
reference critique service.

## Runnable, no-credential examples

The workflow above needs a hosted critique service to produce a real review.
To see the whole delivery path run end to end on your machine with **no keys and
no network**, use the demos backed by fixtures (from a Gate clone):

```bash
pnpm install --frozen-lockfile

pnpm demo         # the sandbox supervisor contains a fixture preview server
pnpm demo:review  # replays a recorded critique through the real delivery path,
                  # writing the exact sticky comment, Check Run and annotated PNGs
```

`pnpm demo:live` runs the same chain against a critique service you start
locally — see [Running your own critique service](../README.md#running-your-own-critique-service-and-pointing-gate-at-it).
