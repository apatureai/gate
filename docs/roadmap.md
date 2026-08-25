Part of [gate](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Status

What runs today, from a clean clone, with no credentials:

| Component | Status | Notes |
|---|---|---|
| Sandbox supervisor | **Works** | `pnpm demo`; resource cap applies on Linux only |
| Review delivery (comment, Check Run, annotation) | **Works** | `pnpm demo:review` |
| Engine client (async jobs, HMAC, schema checks) | **Works** | Driven against a real `verdict` over HTTP; `pnpm demo:live` |
| Action path orchestration (`runAction`) | **Works** | Covered end to end in `@gate/e2e` |
| Preview login sealing (`gate auth`) | **Works** | Runs offline against a bundled fixture |
| GitHub Action, live | **Needs an endpoint** | Code complete and proven against a locally run `verdict`. The [`install-path-e2e`](../.github/workflows/install-path-e2e.yml) job builds `Dockerfile.action` for `linux/amd64` and runs it against a scratch repo with an adopter's directory layout mounted at `/github/workspace`, asserting the neutral "Engine not configured" Check Run is published — so the image is proven to run in *someone else's* repo, not only gate's own (the [install badge](../README.md) is that job). Needs a critique service you host; `apatureai/gate@v1` resolves |
| App path (webhooks, queue, Postgres, RLS) | **Needs provisioning** | Tested against PGlite and in-memory fakes |
| Dashboard | **Builds** | Core logic tested; the Next.js shell is a thin renderer over it |
| Billing | **Untested against Stripe** | Stripe plumbing and tier limits are unit-tested; no real charge has ever run |
| Screenshot capture and model critique | **Not implemented here** | Lives behind the HTTP contract in `packages/types`; run [`verdict`](https://github.com/apatureai/verdict) or write your own, see roadmap item 1 |
| Screenshot object store | **Not implemented** | The finding browser signs URLs through `GATE_SCREENSHOT_OBJECT_URL_TEMPLATE`; no adapter ships |
| Baseline before/after screenshot comparison | **Built, unwired** | `packages/delivery/src/baseline.ts` builds the capture pairs; nothing on the review path calls it. Unrelated to the measurement baseline below, which is wired |
| Measurement baselines (scoping `block` to what a PR introduced) | **Works, needs a baseline on record** | Stored per repository and commit in `measurement_baselines` on the App path. A set is recorded for each reviewed commit, carried onto a merge commit whose tree sha is identical to the reviewed head's, and recorded for every commit a `push` lands on the default branch. The Action path has no database and binds no store, so it classifies nothing and gates nothing, and says so on every run |
| Measure-only capture for a default-branch push | **Needs a service that implements it** | Gate's half is here: the `push` subscription, the guards, the client (`POST /measurements`), and the store write. The capture behind it is the critique service's half, exactly like the review, and [`verdict`](https://github.com/apatureai/verdict) does **not** implement the endpoint yet. Against a service that does not, a push gets a 404, records nothing, spends nothing, and logs why |

Verified on 2026-08-24, macOS 15.6, Node 24.14.0, pnpm 10.34.3:

```
pnpm install --frozen-lockfile   lockfile up to date, exit 0
pnpm build                       tsc -b, clean, exit 0
pnpm lint                        eslint . --max-warnings=0, exit 0
pnpm typecheck                   tsc -b, exit 0
pnpm test                        Test Files  129 passed (129)
                                       Tests  1336 passed (1336)
                                    Duration  32.23s
pnpm audit                       No known vulnerabilities found
```

And in `apps/dashboard`, which is built separately with npm:

```
npm ci                           49 packages, 0 vulnerabilities
npm run build                    next build, 12 routes, exit 0
npm run typecheck                tsc --noEmit, exit 0
npm audit                        found 0 vulnerabilities
```

The no-credential demos (`pnpm demo` and `pnpm demo:review`) were re-run against this revision, and their transcripts above are from those runs. The `pnpm demo:live` transcript is from a `verdict` built from its `f387f15`, served on `127.0.0.1:8791`.


## Roadmap

Concrete, pickup-able work. Each one names the seam it plugs into.

1. **A reference critique service.** This is the biggest single unlock. Gate calls out over HTTP for browser capture and the model critique; the transport seam is `createHttpEngineTransport` in `packages/engine/src/http.ts`, the wire contract is `packages/types` (`GateReviewRequest` / `GateReviewResult`), and `packages/types/fixtures/` holds the golden fixture that anchors both sides. A minimal implementation is Playwright capture plus one vision-model call returning a `GateReviewResult`. Nothing else on this list matters as much.
2. **A fixture-backed transport people can import.** The review demo replays a recorded response, but that replay lives inside the demo CLI rather than being exported. A `createFixtureEngineTransport` on `@gate/engine`'s public surface would let anyone run the whole Action path against their own repository with no endpoint at all. Small, high leverage, good first issue.
3. **Wire up baseline before/after SCREENSHOT comparison.** `packages/delivery/src/baseline.ts` already builds `ComparisonPair`s and `BeforeAfterArtifact`s behind a `BaselineStore` interface, and it is tested, but no caller exists on the review path. Deciding where the base capture comes from is the interesting half. (The measurement baseline is a different thing and is wired: see [Scoped to what the pull request introduced](measured-half.md#scoped-to-what-the-pull-request-introduced).)
3b. **Give the Action path somewhere to keep a measurement baseline.** `runAction` accepts a `measurementBaselines` store and the App path binds a Postgres one, but a GitHub-hosted runner has no database, so the stock Action can never scope `rules.measurements: block` and correctly refuses to gate. A store backed by the Actions cache or by a committed lockfile-style artifact, implementing the same two-method `MeasurementBaselineStore` interface, would close that.
3c. **Implement the measure-only endpoint in a critique service.** A default-branch push records a measurement baseline by asking for measurements and nothing else: `POST /measurements` with a `GateMeasurementRequest`, answered with a `GateMeasurementResult` (measured facts, coverage, capture and engine versions, and no grade or findings). Gate's client, guards and store write are done and tested (`packages/engine/src/measure.ts`, `packages/service/src/default-branch-baseline.ts`); no service implements the endpoint yet, including `verdict`, so every push currently gets a 404 and records nothing. For a service that already captures and measures for a review, this is the same capture with the model call removed, and it is what makes `rules.measurements: block` fire on a busy repository.
4. **Ship an object-store adapter for screenshots.** `GATE_SCREENSHOT_OBJECT_URL_TEMPLATE` expects a `{objectKey}` template today, and `packages/dashboard` already mints short-lived capability tokens. An S3 or R2 signed-GET signer implementing the same interface would close the loop.
5. **Keep the dependency tree clean.** Both trees audit clean as of 2026-08-10, and staying there is the ongoing job. The eleven advisories that were open the day before are cleared in [SECURITY.md](../SECURITY.md#dependency-advisories), which also records the one pinned override holding a fix in place. Dependabot opens the bumps; what is missing is a CI job that fails on a new advisory rather than leaving it to whoever next runs `pnpm audit` by hand. That job is the pickup-able piece, and it wants the same drift policy as item 10.
6. **Aggregate cgroup-v2 caps for the supervisor.** The `ulimit` caps are per-process. `pids.max` and `memory.max` on a cgroup would make containment aggregate rather than per-process, which is the difference between a mitigation and a sandbox. Needs host setup, so it wants a design discussion first.
7. **Windows support.** The supervisor relies on POSIX process groups. A Job Object based implementation behind the same `startLocalServer` signature would be a substantial and self-contained contribution.
8. **List the Action on the Marketplace.** The moving major tag `v1` is cut and pushed, so `uses: apatureai/gate@v1` resolves and the Docker action (`action.yml` + `Dockerfile.action`) builds and runs in an adopter's repo — the `install-path-e2e` job holds that guarantee against the relative-ENTRYPOINT regression that had it crash on every non-gate checkout. What is left is the Marketplace listing itself, which is a repository-owner step from the Releases page.
9. **A scheduled live-pipeline smoke test.** `packages/e2e/test/golden-path.test.ts` asserts the full Action path against a mock engine. The scheduled variant that runs it against a real deployment was specified and never wired.
10. **Restore the image-and-SBOM CI job.** Both Dockerfiles build today, but the job that built them, generated SBOMs and failed on fixable medium-or-higher vulnerabilities is not in `.github/workflows/ci.yml`. It needs a policy for base-image CVE drift so it does not go permanently red.

Longer-horizon design changes, each with the trigger that would justify it, are in [Deferred by design](#deferred-by-design).


## Known limitations

Stated up front, because finding them after you have wired Gate in is worse.

- **Half the system is behind an HTTP contract you have to implement.** Every claim about screenshot quality, model behaviour, prompt design or finding accuracy belongs to the critique service. Gate's tests prove Gate's orchestration and delivery; they prove nothing about review quality. There is a reference implementation to run ([`verdict`](https://github.com/apatureai/verdict)) and a command that drives the whole chain against it (`pnpm demo:live`), but the review itself is still someone else's half. Roadmap item 1.
- **Review quality is entirely the service's, and Gate can only tell you whether a model was involved at all.** The `provenance` stamp answers "did anything judge this?", not "was the judgment any good?". A service that runs a real but bad model gets a real, bad review published verbatim.
- **The Action path constrains hostile pull request code; it does not sandbox it.** The `ulimit` caps, environment allowlist, loopback-redirect refusal and fork gating are real mitigations. The aggregate cgroup-v2 caps that would make them airtight are roadmap item 6. Read the threat model before running the Action path on a repository that accepts fork pull requests.
- **On a fork pull request, the Action publishes nothing, and the step is still green.** This is GitHub's rule, not Gate's: on a public repository, a workflow triggered by `pull_request` from a fork gets a read-only `GITHUB_TOKEN` and none of the repository's secrets, and the workflow's `permissions:` block cannot raise either. (Private repositories have an Actions setting that can send write tokens and secrets to fork pull requests; public ones do not.) So `GATE_ENGINE_ENDPOINT` and `GATE_ENGINE_HMAC_SECRET` arrive empty, and the "Engine not configured" Check Run that would have said so is itself refused with a 403. What you get is one line in the Action log (`Apature Gate action error: create check run failed: 403`, with the permissions hint) and a **green workflow run with no Gate check on the pull request at all**. Nothing distinguishes that from a repository where Gate ran and found nothing wrong, which is the reading to be careful of: on fork pull requests, absence of a Gate check is not a pass. Gate stays green deliberately, because a reviewer that cannot report must not fail somebody's build, but the honest consequence is that **the Action path only reviews pull requests from branches of the repository itself**. Contributors' forks need the App path, where publishing runs under the installation's own token.
- **Component-library detection reads one file, at the repository root.** Gate looks at `package.json` at the PR's head and nothing else, so a monorepo whose UI package declares Radix in `packages/web/package.json` is not detected, and neither is a library vendored without a dependency entry. The review still runs, grounded on tokens and brand; it simply carries no library rubric note, and nothing in the result distinguishes that from a repository that genuinely uses none. On the App path the read can also fail for reasons that have nothing to do with your code (a rate limit, a permission change), and it fails quietly on purpose: grounding must never be able to fail a pull request's review.
- **A measurement baseline can carry a violation to the wrong element, and it errs that way on purpose.** After the selector keys miss, a violation is matched on check, page and the substance of the engine's sentence, and it may claim one stored violation that nothing else accounts for. That is what makes a wrapper div, a tightened combinator or a renamed class stop reading as a new defect. It also means a pull request that fixes one contrast failure and adds another with the same sentence on the same page is reported as one fixed and one already on the base, rather than one fixed and one introduced, so that one does not fail the check. It is still rendered, still counted, and still in the review. The count is the guard: the number of same-defect violations on a page cannot grow without something being called introduced. What Gate will not do is match across pages, so a renamed route is *Not classified* rather than carried over.
- **A default-branch baseline is only as true as what was deployed when the push arrived.** The push fires the moment the commit lands; a repository that deploys after CI is still serving the previous build at that instant, so a *stable* `default_branch_url` can be captured, measured, and filed under a commit whose UI it does not show. Gate cannot tell the two apart from the outside: the URL answers 200 either way. Point `default_branch_url` at a per-commit address with `{sha}` or `{short_sha}` if you need the set to be certainly about the commit it names.
- **A baseline measured at your default branch's deployment cannot be attributed, so it is reported and never gated.** Production and a preview differ for reasons no pull request caused, so a comparison whose two sides came from those two surfaces reports what it cannot place instead of calling it new, and `rules.measurements: block` does nothing on that run. Two previews stay comparable however different their addresses, which is the ordinary case and still fails a build on a violation a pull request really did introduce. If your default branch deploys somewhere that renders like your previews, `preview.default_branch_renders_like_preview: true` restores gating there; Gate will not infer that from a URL. Sets stored before the environment was recorded compare as they always did, because unknown is not a difference.
- **Nothing backfills history, so only the branch *tip* is scoped when you install.** Installing the App measures the default branch's current commit, and every commit that lands on it afterwards is measured as it lands. Everything older than that has no baseline, a pull request based on one of those commits reads `no baseline`, and there is no command that goes and measures history. A repository that has not set `preview.default_branch_url`, or whose deployment is not reachable at install time, gets nothing even at the tip and waits for its first push.
- **The measure endpoint is a contract nobody has implemented yet.** Gate's `push` handling, guards, client and store write are here and tested; `POST /measurements` is the critique service's half and `verdict` does not implement it. Until one does, a push on a live deployment records nothing, and the honest reading is that this closes the gap in Gate and not yet in the system. Roadmap item 3c.
- **The resource cap is Linux-only, and one half of it depends on the shell.** `ulimit -v` does not apply on macOS; `ulimit -u` does not exist in dash, so Gate runs the capped command under `/bin/bash` when present and falls back to the memory cap alone when it is not.
- **Windows is not supported.** The supervisor relies on POSIX process groups. Roadmap item 7.
- **Nothing fails CI on a new dependency advisory.** Both trees audit clean today and the history is in [SECURITY.md](../SECURITY.md#dependency-advisories), but no job enforces that, so the guarantee is only as fresh as the last manual `pnpm audit`. Roadmap item 5.
- **Billing has never processed a real charge.** The Stripe plumbing and tier limits are unit-tested against fakes.
- **Some source comments cite documents that are not in this repository.** Issue numbers (`#70`, `#79`, …) point at this repository's tracker, and section references like `TRD §7` or `ARCHITECTURE §6` point at design documents that were not published. The load-bearing parts of both are absorbed into this README; the citations are left in place as the record of why each piece exists.


### Deferred by design

Each of these was a considered decision with a named trigger, not an oversight. The hard invariants that hold across every one of them: Gate is judgment-only (no `contents: write`), the supersession identity `repo#pr` and the durable completed-review identity `(repo_owner, repo_name, pr_number, head_sha)`, the publish-time SHA guard, and `stale_publish_rate = 0`.

- **A completion-webhook callback instead of polling.** Today Gate polls with depth-aware backoff to a 10-minute deadline. **Trigger:** poll cost or time-to-first-comment regresses at scale.
- **Pact consumer-driven contract tests instead of a shared golden fixture.** Today a golden fixture plus `x-schema-version` plus a Zod runtime parse keeps the two sides from drifting. **Trigger:** the critique service starts deploying independently of Gate.
- **Short-lived JWT and a JWKS endpoint instead of a shared HMAC secret.** Today requests are HMAC-SHA256 signed and scoped to `installationId`. **Trigger:** more than one independent service calls it.
- **Inngest `singleton: { key: "repo#pr", mode: "cancel" }` instead of BullMQ.** Today BullMQ sits behind a `ReviewJobWorker` interface with cooperative cancellation; BullMQ cannot preempt an active job, which is why the publish-time guard exists. **Trigger:** stale-publish rate non-zero for two consecutive weeks.
- **Transactional outbox plus a REST reconciliation sweep.** Today delivery is at-least-once webhook dedupe on `X-GitHub-Delivery` plus rate-limit backoff. **Trigger:** an observed crash-window inconsistency (a delivered review with no database record, or the reverse).
- **Service-side request-digest validation on idempotency conflicts.** Today Gate domain-separates its caller key (`gate-review-v2`) and refuses a mismatched client-outcome identity before publication. **Trigger:** a second independently deployed caller, or enabling blocking mode.


## Running a live review

**On the Action path, nothing else is needed.** A critique service, two environment variables, and a workflow: that is the whole list, and [`pnpm demo:live`](../README.md#running-your-own-critique-service-and-pointing-gate-at-it) proves the chain before you commit a workflow file. Everything below is the App path.

**On the App path**, the code seam is done and provisioning is an operator action. Beyond the environment variables above you need: a Postgres instance whose app role is a non-superuser without `BYPASSRLS` (otherwise the row-level-security tenant isolation is decorative), a Redis with `maxmemory-policy=noeviction`, a KMS key bound to the secret store, an object store for screenshots, a GitHub App created from `buildAppManifest` with its webhook pointed at your `/webhook`, and, above all, a reachable critique service implementing the job protocol above (roadmap item 1).

Enterprise-style accounts can route to an in-VPC service instead: each account has an optional KMS-encrypted `engineEndpoint`, and `createAccountEngineTransport` targets **only** that endpoint. There is no fallback path to a shared service, so an in-VPC outage surfaces as `not_reviewed` rather than sending screenshots to a third party.

