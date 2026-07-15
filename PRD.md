# Apature Gate - Product Requirements Document

Created: 2026-06-15
Status: MVP specification for YC-facing product wedge
Canonical company context: `apatureai/core`
Shared technical substrate: `apatureai/judgment-engine`

## 1. One-Line Pitch

Apature Gate is the GitHub-native design reviewer for AI-generated frontend PRs: it screenshots every preview deploy, judges the rendered UI against the repo's design system and UI DNA, and comments on the PR with annotated, agent-actionable findings.

Positioning: Applitools checks pixels. Apature checks judgment.

## 2. Why Now

AI agents can generate frontend code faster than human teams can review it. The bottleneck has moved from production to judgment: someone still has to decide whether the generated UI is good enough to ship.

Current tools miss the opening:

- AI code reviewers inspect source code, not the rendered artifact.
- Visual regression tools detect pixel change, not design quality.
- Design tools review Figma work, but AI-generated code often never goes through Figma.
- Coding agents can generate UI, but the generator grading its own work is not a neutral gate.

Gate starts where the pain is visible: pull requests with preview deploys. It gives teams a neutral reviewer that sees the actual UI and speaks in concrete tokens, elements, and screenshots.

## 3. Target Users And Buyer

Primary users:

- AI-assisted frontend developers using Cursor, Claude Code, Codex, v0, or similar tools.
- Engineering leads reviewing large volumes of generated UI PRs.
- Design-system maintainers who cannot manually inspect every frontend change.

Economic buyer:

- Seed to growth engineering teams for self-serve usage.
- Platform engineering and design-ops leaders for hosted paid usage.

Initial ICP:

- Web SaaS teams using GitHub, preview deploys, and AI coding agents.
- Teams with enough design consistency to care about drift but not enough design-review capacity to manually catch it.

## 4. Product Promise

Gate must answer four questions on every relevant PR:

1. What changed visually?
2. Does it violate this repo's design system, UI DNA, or visual quality bar?
3. Where exactly is the issue in the rendered UI?
4. What should the developer or their agent change?

The product judges and verifies. It never edits code, commits fixes, or drives the customer's application. Suggestions are machine-actionable so the customer's own coding agent can apply them.

## 5. MVP Scope

In scope for MVP:

- GitHub Action for zero-infra adoption.
- GitHub App path for hosted paid usage.
- Preview URL discovery from deployment webhooks, explicit action input, PR comment fallback, and local serve fallback.
- Sticky PR comment with annotated screenshots.
- GitHub Check Run named `design-review`.
- Advisory default, with blocking only when the repo opts in.
- `.designreview.yml` configuration for preview source, route selection, viewport defaults, brand text, and gating rules.
- Integration with `judgment-engine` through `critique(images, context) -> Findings`.
- Feedback capture from collaborator responses and later fix outcomes.

Out of scope for MVP:

- Functional testing and E2E assertions.
- Pixel-diff regression as the primary product.
- Code edits, auto-commits, autofix PRs, or bundled code generation.
- Live browser overlay and pointer sessions. That belongs to `apatureai/pointer`.
- Agent request/response MCP tools. That belongs to `apatureai/mcp-review`.
- Autonomous interaction exploration. That belongs to `apatureai/interactive-review`.

## 6. Core User Flow

1. A developer opens or updates a PR.
2. The deploy provider posts a successful preview deployment, or the Action receives an explicit preview URL.
3. Gate records `current_sha[repo#pr]`, waits for preview readiness, and creates a review job.
4. Gate asks `judgment-engine` to capture the relevant routes and run critique.
5. Gate validates that the result still matches the newest PR head SHA.
6. Gate posts or updates one sticky PR comment and one Check Run.
7. The developer or their agent fixes the UI.
8. A later push repeats the loop, generating resolved or unresolved feedback labels.

Correctness rule:

- Supersession key: `repo#pr`.
- Durable completed-review identity: `(repo_owner, repo_name, pr_number, head_sha)`.
- Engine idempotency: a versioned hash of canonical `(repo_owner, repo_name,
  pr_number, full_head_sha)`; it never substitutes for either key above.
- Publish guard: never post a result whose SHA is no longer the PR head.

## 7. Finding Experience

A finding must be specific enough that a developer or agent can act without another round of interpretation.

Each finding includes:

- Severity: `blocker`, `should_fix`, or `nit`.
- Dimension: hierarchy, spacing, typography, color, system conformance, responsive behavior, accessibility, or brand fit.
- Route and viewport.
- Stable element reference from the DOM geometry map.
- Evidence that points at the visible UI.
- Concrete suggestion: token, class, component, or layout change.
- `introduced_by_this_pr` when the evidence supports it.

The PR comment should show the trust budget:

- Blockers first.
- Should-fix items collapsed after the top few.
- Nits collapsed by default.
- Permanent app routes for annotated screenshots, not expiring object URLs.

## 8. Demo Path For YC

The canonical demo:

1. Start with a small SaaS app that has a clear design system.
2. Use an AI coding agent to open a PR that subtly breaks the UI: off-scale spacing, a hard-coded purple, a misaligned CTA, or a mobile overflow.
3. Show the preview deploy.
4. Gate posts a PR review in under two minutes with annotated screenshots and concrete suggestions.
5. The agent applies the fix.
6. Gate re-runs and the Check Run passes.

The demo must feel obvious: the user should see the screenshot and immediately agree the finding is real.

## 9. Pricing Hypothesis

Self-serve:

- Free tier for public repos or limited private usage.
- Paid team tier around $20 per developer per month.

Hosted paid tier:

- GitHub App install, persistent feedback memory, dashboard, baseline comparison, and no CI-minute burden.

Enterprise:

- Fully managed by default: Apature runs model serving, so consumers never manage a model key.
- Enterprise data residency via the self-hosted / in-VPC `judgment-engine` path, when a customer requires screenshots to stay in their cloud.
- DPA, retention controls, SSO, and design-system reporting.

MCP and Pointer usage may be metered later, but CI Gate is the first revenue surface.

## 10. Success Metrics

Activation:

- Repositories with at least one successful review.
- Percentage of installs that configure a working preview source.
- Time from install to first annotated PR comment.

Trust:

- False-positive rate by severity.
- Stale-review publish rate, target zero.
- Capture instability rate.
- Percentage of findings with valid element references after post-parse validation.

Business:

- Weekly active repositories.
- Reviews per active repo.
- Action-to-App conversion.
- Paid conversion from active private repos.

Data moat:

- Labeled finding tuples per active repo.
- Findings accepted, ignored, or resolved.
- Repeated design preferences captured in per-repo memory.

## 11. Sequencing

Gate is the startup wedge.

Build order:

1. GitHub Action and preview URL path.
2. Sticky PR comment and Check Run.
3. Hosted GitHub App path.
4. Feedback memory and dashboard.
5. Baseline comparison.
6. MCP Review and Pointer expansion only after Gate proves trust.

Gate must not wait for every future Apature surface. It only needs to make one PR review feel indispensable.

## 12. Risks

Judgment quality risk:

- Generic findings kill trust. Mitigation: only ship findings grounded in visible screenshots, DOM element refs, repo context, and concrete suggestions.

Capture risk:

- A screenshot of a loading state or broken preview creates false critique. Mitigation: readiness protocol, stability flags, and explicit not-reviewed reasons owned by `judgment-engine`.

Distribution risk:

- Developers may ignore another PR bot. Mitigation: small finding budget, annotated screenshots, advisory default, and agent-actionable suggestions.

Platform absorption risk:

- Coding agents may add their own visual review. Mitigation: neutral judge, GitHub-native enforcement, repo-specific UI DNA, and preference data across mixed-tool teams.

Scope risk:

- Gate can sprawl into the whole platform. Mitigation: Gate owns GitHub product delivery; `judgment-engine` owns capture, model, eval, data, and shared security.

## 13. Repository Boundary

This repo owns:

- GitHub Action and GitHub App product behavior.
- PR sticky comment and Check Run UX.
- Gate-specific configuration and onboarding.
- Gate dashboard and billing surfaces.
- Gate product docs, GTM docs, and demo path.

This repo does not own:

- Capture engine internals.
- Repo context extraction internals.
- Qwen3-VL model calls.
- Evaluation harness.
- Preference dataset implementation.
- MCP or live pointer product surfaces.

Those belong to the other Apature repos referenced in `ARCHITECTURE.md`.

## 14. Implementation Backlog

The Gate backlog is tracked as GitHub milestones M0 through M4. The build is end to end only when Gate's own runtime and the `judgment-engine` seam are first-class, not assumed.

- **M0 - Foundation and runtime.** Gate's own substrate: monorepo and shared contract types, CI, Fly deploy, Postgres, Redis, secrets and KMS, and observability with a stale-publish alert. Every orchestrator and delivery issue assumes this exists.
- **M1 - Action path.** The zero-infra Action: preview resolution (explicit and local-serve), the `judgment-engine` client, engine failure and degradation handling, gate-side preview-source verification, sticky comment, Check Run, config schema, and the end-to-end acceptance harness.
- **M2 - App path.** Hosted GitHub App: webhook auth, deployment-status discovery, queue, supersession and publish guard, multi-provider previews, minimal permissions, and the feedback event model forwarded to the shared store.
- **M3 - Hosted tier.** Dashboard shell, run history, finding browser, config UI, feedback stats, and Stripe billing with free-tier limits, SSO, and the enterprise in-VPC residency option.
- **M4 - Trust polish.** Baseline comparison, permanent annotated image routes, Marketplace listing, the YC demo golden-path repo as an automated smoke test, and public launch artifacts.

The single most important seam is the `judgment-engine` client (`GateReviewRequest -> GateReviewResult`): Gate owns when to call and how to publish, the engine owns capture, context, model, and validation. Gate-side security covers preview-source provenance and gate-held secret custody; deep SSRF, DNS-rebind, egress, screenshot encryption, and prompt-injection controls remain owned by `judgment-engine`.

## 15. Research-Backed Positioning

Added: 2026-06-16

Gate is differentiated by where it sits and what it judges:

- It is not a visual-regression product. Applitools, Chromatic, and Percy already catch visual changes, visual bugs, and cross-browser diffs. Gate starts after the screenshot exists and asks whether the rendered UI is good product/design judgment for this repo.
- It is not an AI source-code reviewer. GitHub Copilot code review and adjacent PR reviewers inspect code and suggest source-level fixes. Gate inspects the preview deploy and grounds feedback in visible elements, screenshots, DOM geometry, and UI DNA.
- It is not a browser agent. OpenAI computer use, Playwright MCP, Stagehand, and related browser-agent tools are about operating or inspecting UIs. Gate is a neutral reviewer: it judges and verifies, then leaves action to the developer or their coding agent.
- It is not a design-tool review product. The wedge exists because AI-generated UI often goes straight from prompt to PR without passing through Figma.

The unique claim:

Gate is the GitHub-native, rendered-UI judgment layer for AI-generated frontend PRs. It combines preview deploys, design-system context, UI DNA, a VLM judge, element grounding, and PR-native delivery into one workflow.

The cutting-edge part is not "we call a vision model." The cutting-edge part is the loop:

1. Rendered UI evidence.
2. Repo-specific UI DNA.
3. Neutral review at the PR boundary.
4. Agent-actionable suggestions.
5. Feedback and fix outcomes that improve the team's design memory.

This keeps the company out of the crowded generic-agent lane and inside the more defensible judgment-data lane.

Primary sources and competitor notes are maintained in `RESEARCH.md`.

## 16. Ecosystem Placement

Added: 2026-06-16

Gate is the first product surface in a broader Apature ecosystem.

Its place:

- Gate is the YC wedge, first demo, and first revenue surface.
- `judgment-engine` is the substrate Gate calls; Gate should not absorb capture, model, eval, or shared feedback ownership.
- `ui-dna` is the canonical design standard Gate judges against. Early Gate can use `.designreview.yml`, but the company gets more defensible as UI DNA becomes signed off and versioned.
- `ui-graph` is a later perception/compression layer that can make Gate cheaper and more grounded; it is not a Gate M1 blocker.
- `mcp-review` and `pointer` are in-loop/live siblings that reuse the same engine and DNA after Gate proves trust.
- `interactive-review` is the v2 metered tier for UI states static screenshots miss.
- `source-of-truth` pushes approved UI DNA upstream to agents before they generate UI.
- `entropy-engine` handles whole-codebase design drift; Gate remains PR-level judgment.
- `dna-consultant` packages the enterprise carry-forward workflow over UI DNA, Gate, Source Of Truth, and Entropy Engine.

Rule:

Gate makes the ecosystem legible, but Gate must not become the ecosystem. Its job is to make one PR review feel indispensable, then feed the data and trust loops that make the later products possible.

The fuller map lives in `ECOSYSTEM.md`.
