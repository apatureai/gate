# Apature Gate - Technical Requirements Document

Created: 2026-06-15
Status: MVP build specification

## 1. Technical Summary

Gate is the GitHub delivery product for Apature. It receives PR and deployment events, discovers a preview URL, coordinates one review per current PR head SHA, calls `judgment-engine`, and publishes one sticky PR comment plus one Check Run.

Gate is not the critique engine. Its job is orchestration, GitHub UX, configuration, product packaging, and delivery correctness.

Primary dependency:

```ts
critique(images, context) -> Findings
```

`judgment-engine` owns capture, context extraction, Qwen3-VL model calls, validation, eval, and shared feedback primitives. Gate owns when to call it and how to publish results.

## 2. External Surfaces

### GitHub Action

Purpose:

- Zero-infra adoption.
- Free/public tier.
- Local-serve fallback for repos without preview deploys.

Minimum inputs:

```yaml
preview-url: null
preview-command: null
config-path: .designreview.yml
gate-mode: advisory
```

Behavior:

- If `preview-url` is provided, review that URL.
- If no URL is provided and `preview-command` exists, run the command, wait for localhost readiness, then review localhost.
- The Action path can run capture inside the user's runner, but still calls the hosted critique API unless configured otherwise.

### GitHub App

Purpose:

- Hosted paid tier.
- Webhook-driven reviews.
- Persistent feedback memory and dashboard.

Minimum permissions:

- `checks: write`
- `pull_requests: write`
- `contents: read`
- `deployments: read`

Forbidden permission:

- `contents: write`

The no-write permission boundary is a product requirement, not just a security preference.

### PR Comment

Behavior:

- One sticky comment per PR.
- Locate by hidden HTML marker.
- Update in place.
- Include grade, summary, blockers, should-fix findings, nits, not-reviewed routes, and annotated screenshot links.
- Feedback actions must not mutate state on GET.

### Check Run

Name:

```text
design-review
```

Conclusion mapping:

- `ship` -> success.
- `ship_with_nits` -> success.
- `needs_work` -> neutral.
- `blocked` -> neutral by default, failure only when repo config opts into blocking.

## 3. Configuration

Gate reads `.designreview.yml` from the repo root when available.

Minimum supported shape:

```yaml
preview:
  source: vercel
  environment: Preview
  url_template: null
  wait_seconds: 0
  ready_selector: null
  protection_bypass: null
  auth: null

routes:
  always: ["/"]
  max_per_pr: 5
  map: {}

viewports: [mobile, desktop]
dark_mode: false

brand: |
  Product description, audience, tone, and design rules.

rules:
  gate: none
  min_severity_to_comment: nit
  suppress: []
```

Defaults:

- Missing config is valid.
- Default gate mode is `none`.
- Default viewports are mobile and desktop.
- Default route is `/` when route inference cannot find a stronger candidate.

Gate validates config and passes normalized values to `judgment-engine`; it does not implement design-token extraction itself.

## 4. Preview URL Discovery

Resolution order:

1. GitHub deployment status with `state == success`.
2. Explicit Action input.
3. Configured `preview.url_template`.
4. Known provider bot comment scrape.
5. Action local-serve fallback.

Deployment status requirements:

- Match deployment SHA to PR head SHA.
- Match configured environment name, default `Preview`.
- Ignore Storybook or non-app deployment environments unless configured.
- Dedupe on `(sha, deployment_id)`.

Protected preview support:

- Vercel bypass uses the configured `protection_bypass` secret name.
- Secrets are never logged.
- Auth state is disabled for fork PRs.

## 5. Queue And Supersession

Gate must be correct under rapid AI-generated push bursts.

Definitions:

- Supersession key: `repo#pr`.
- Completed-review identity: `(pr, head_sha)`.

Required behavior:

- On enqueue, write `current_sha[repo#pr] = head_sha`.
- If a newer push arrives, signal cancellation for any active older job where possible.
- Every stage checks whether its job SHA still matches the current SHA before doing expensive work.
- Before publishing a comment or Check Run, re-read the current SHA and discard stale results.
- Use optimistic comment update behavior so older writers cannot overwrite newer comments.

Rate limits:

- At most one full review per PR per 10 minutes.
- Pushes inside the full-review window may run triage-only.
- Per `(repo, pr)` concurrency is 1.
- Per installation concurrency is tier-based and fair-scheduled.

## 6. Gate-To-Engine Request

Gate calls the shared engine with normalized product intent and GitHub context.

Minimum request fields:

```ts
type GateReviewRequest = {
  installationId: string;
  repository: {
    owner: string;
    name: string;
    defaultBranch: string;
  };
  pullRequest: {
    number: number;
    headSha: string;
    baseSha: string;
    title: string;
    body: string | null;
  };
  preview: {
    url: string;
    provider: "vercel" | "netlify" | "cloudflare" | "render" | "explicit" | "local";
    environment: string | null;
  };
  config: NormalizedDesignReviewConfig;
  publishMode: "advisory" | "blocking";
};
```

Minimum response fields:

```ts
type GateReviewResult = {
  grade: "ship" | "ship_with_nits" | "needs_work" | "blocked";
  overall: string;
  findings: Finding[];
  notReviewed: string[];
  artifacts: {
    annotatedScreenshots: Array<{ findingId: string; url: string }>;
    runUrl?: string;
  };
  metadata: {
    engineVersion: string;
    model: string;
    promptVersion: string;
    captureVersion: string;
  };
};
```

Current model assumption:

- Qwen3-VL is the default judge through `judgment-engine`.
- Gate docs, UI, and code must not hard-code Claude as the primary model.

## 7. Delivery Requirements

Sticky comment:

- Always includes the reviewed commit SHA.
- Always includes a "not reviewed" section when any route, viewport, or preview was skipped.
- Annotated image links use stable app routes, not raw expiring object URLs.
- Feedback actions route to POST-backed endpoints or GitHub-native reactions/commands.

Check Run:

- Must include summary, grade, and link to the sticky comment or dashboard run.
- Must never fail by default.
- Failure requires explicit `rules.gate: blockers` or equivalent opt-in.

Dashboard handoff:

- MVP can link only to artifacts.
- Hosted tier adds run history, finding browser, config UI, and feedback stats.

## 8. Security Requirements

Gate security requirements:

- Never request `contents: write`.
- Never commit or push code.
- Never mutate feedback on GET.
- Verify GitHub webhook signatures.
- Store installation tokens securely and scope them to the installation.
- Do not log preview bypass secrets, storage state, signed URLs, or screenshot contents.
- Disable auth storage state on fork PRs.
- Pass preview URLs to `judgment-engine` only after provider/source verification.

Shared security delegated to `judgment-engine`:

- SSRF protection.
- DNS rebind checks.
- Sandbox egress policy.
- Screenshot encryption and retention.
- Prompt-injection controls.

## 9. Data And Feedback

Gate records product-facing feedback events and forwards them to the shared feedback store.

Events:

- Finding posted.
- Finding expanded or clicked when available.
- GitHub reaction or slash-command feedback.
- Ignore/suppress command.
- PR merged with unresolved blockers.
- Later diff appears to adopt a suggested token or class.

Data quality rules:

- GET requests are inert.
- Non-collaborator feedback is down-weighted by the shared data layer.
- "Touched the element" is not enough to count as implicit positive feedback.

## 10. MVP Milestones

Milestone 1: Action path

- Explicit preview URL input.
- Local serve fallback.
- Call hosted `judgment-engine`.
- Post sticky comment.
- Publish Check Run.

Milestone 2: App path

- GitHub App auth.
- Deployment status webhook handling.
- Queue, supersession, stale publish guard.
- Vercel/Netlify/Cloudflare/Render preview detection.

Milestone 3: Hosted tier

- Dashboard shell.
- Run history.
- Config UI.
- Billing and free-tier limits.
- Feedback stats.

Milestone 4: Trust polish

- Baseline comparison.
- Permanent annotated image routes.
- Marketplace listing.
- YC demo repo and public launch artifacts.

## 11. Acceptance Criteria

The MVP is acceptable when:

- A PR with an explicit preview URL gets a useful annotated design review.
- A PR with a deployment status preview gets a useful annotated design review.
- Rapid pushes cannot publish stale comments.
- A blocker does not fail the Check Run unless blocking is configured.
- The app functions without `contents: write`.
- Comment feedback cannot be triggered by URL unfurlers.
- Docs and UI consistently describe Gate as judgment-only, not autofix.
