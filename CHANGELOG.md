# Changelog

All notable changes to Gate are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Gate is distributed as a GitHub Action (a Docker action defined by `action.yml`
and `Dockerfile.action`), not on npm — every workspace package is `private: true`.
Releases are cut as `vX.Y.Z` tags with matching GitHub releases. The moving major
tag **`v1`** is an Actions-convention alias: it is re-pointed at each `v1.x`
release so `uses: apatureai/gate@v1` resolves to the newest one. Pin a commit SHA
if you need an immutable reference.

## [0.1.5] — 2026-08-24

### Fixed

- **`gate-mode` no longer silently overrides `.gate.yml`.** The Action input
  carried `default: "none"`, and an input default is handed to the step exactly
  like a typed value, so omitting `gate-mode` overrode the file with `none` on
  every run. A repository that opted into `rules.gate: blockers` got an advisory
  check that could never fail. An omitted input now leaves `rules.gate` in the
  file to decide; an explicit value still wins over the file.
- **An invalid `gate-mode` is refused instead of silently never gating.** A value
  that is not `none`, `nits`, or `blockers` (for example `blocker`) used to parse,
  publish, and simply never equal `blockers`. It is now rejected outright with a
  neutral "Action setup failed" Check Run naming the input.

### Changed

- **Fork gate hardened.** A pull request whose payload does not state its fork
  status is now treated as a fork rather than assumed same-repo, closing the gate
  when the payload will not say. The fork-token limitation is qualified to public
  repositories, where GitHub hands a fork-triggered run a read-only token and no
  secrets.
- **Baselines compare against the deployment that rendered them.** A measurement
  baseline records where it was captured, so a comparison can tell whether the set
  it is measured against came from a different kind of deployment.
- **Default-branch measurement coverage widened.** The default branch is measured
  on install and on merge commits whose tree matches a reviewed head, so a
  repository's first pull request — and a merge that raced another review — still
  has a baseline on record.

### Adoption / documentation

- Added this `CHANGELOG.md`.
- Bumped every package manifest (root and all 13 workspace packages) from `0.1.0`
  to `0.1.5` so the manifest version tracks the release tag.
- Added [`examples/gate.yml`](examples/gate.yml), a liftable GitHub Actions
  workflow that consumes `apatureai/gate@v1`, plus [`examples/README.md`](examples/README.md).
- Per-package `pnpm test` now runs that package's suite instead of exiting 1 with
  "No test files found"; the script resolves the shared root config with
  `--root ../..`.
- README corrections: the `demo:review` sticky-comment size (1260 bytes), the
  test count (1336 across 129 files), and the workflow example's `actions/checkout`
  pin (`@v7`, matching CI). Removed `OTEL_EXPORTER_OTLP_ENDPOINT` from the
  environment-variable table — Gate reads no `OTEL_*` variable; metric readers are
  injected into `initTelemetry`, and export is the embedding runtime's choice.

## [0.1.4] — 2026-08-18

### Added

- `rules.measurements: off | advisory | block` in the config schema, with
  `advisory` as the default so gating stays opt-in. Under `block`, a measurement
  fails a check only when it is both block-eligible (the engine's own precision
  claim) and answerable to this pull request.
- Measurement baselines: Gate records the measurement set observed at a commit and
  compares a pull request against the set stored for its base, so the first run on
  a mature repository is not handed the whole back catalogue. No baseline never
  gates, and says so.
- Severity bands: a pre-existing violation moved into a worse band can fail a
  check and is reported as already present rather than new. `overflow`-band
  regressions are reported and never gate.

### Fixed

- A violation is placed against the viewport it was measured at, and a markup
  refactor around an untouched violation carries it over rather than reading as one
  fixed plus one introduced.
- A band the engine could not have stated is refused rather than compared.

## [0.1.3] — 2026-08-16

### Fixed

- `verify_stability` in `.gate.yml` no longer rejected with `Unrecognized key`
  (which produced a silent "config invalid, review skipped").
- A green check can no longer mean nothing was verified: an engine can retract its
  own grade, and Gate withholds the grade on a retraction — including a retraction
  reason it has not been taught — rather than defaulting to a pass, in blocking and
  advisory mode alike.

### Added

- Gate tells the engine which component libraries the repository declares (by id,
  never the manifest text, to keep a PR's own `package.json` out of the prompt).
- `verify_stability: true` asks the engine to capture each page twice and compare
  the bytes.

## [0.1.2] — 2026-08-16

### Security

- A pull request could forge Gate's own verdict: engine- and model-supplied fields
  reached the sticky comment unsanitized, so crafted prose could close its
  `<details>` block and open a forged `**✅ Ship**` grade line. Every field
  originating from the engine or the model is now escaped so it cannot open or
  close a block construct, forge a grade line, or break out of a table cell.
- Bare `www.` hosts are defanged, evidence URLs carrying credentials in the
  authority are refused, a pipe in an evidence URL no longer ends the table cell,
  and bidirectional controls (for example U+202E) are stripped.

### Changed

- The Check Run now states the engine's grounding drop count, so zero findings and
  findings that could not be grounded are distinguishable.
- `@v1` re-pointed here; `v0.1.1` renders unsanitized engine output.

## [0.1.1] — 2026-08-16

### Fixed

- A green check can no longer mean nothing was reviewed. Two conditions must hold
  before Gate shows a grade: something judged the page (the service stamps whether
  a model was involved; if not, Gate publishes a neutral *Not judged* /
  *Judgment not stated* check), and something was reviewed (a run that judged none
  of the requested routes gets a neutral *Nothing reviewed* check listing what it
  skipped). Upgrading from `0.1.0` is strongly recommended.

## [0.1.0] — 2026-08-10

### Added

- First tagged release. Gate runs a pull request's preview build inside a hardened
  sandbox, hands the verified preview URL to a critique service you supply, and
  publishes that service's design review back to GitHub as one sticky comment plus
  a Check Run. It judges and reports: it never edits code and never requests
  `contents: write`.
- The sandbox supervisor (process-group teardown, default-deny env allowlist, hard
  `ulimit` caps, loopback-only readiness probing that refuses an off-loopback
  redirect), review delivery (sticky-comment upsert, Check Run mapping, screenshot
  annotation), the Action path orchestration (`runAction`), the engine client
  (async job protocol, HMAC signing, schema-version and Zod checks, fail-closed
  degradation), preview login sealing, and the App path (webhooks, BullMQ queue
  with supersession, Postgres with row-level tenant isolation).

[0.1.5]: https://github.com/apatureai/gate/releases/tag/v0.1.5
[0.1.4]: https://github.com/apatureai/gate/releases/tag/v0.1.4
[0.1.3]: https://github.com/apatureai/gate/releases/tag/v0.1.3
[0.1.2]: https://github.com/apatureai/gate/releases/tag/v0.1.2
[0.1.1]: https://github.com/apatureai/gate/releases/tag/v0.1.1
[0.1.0]: https://github.com/apatureai/gate/releases/tag/v0.1.0
