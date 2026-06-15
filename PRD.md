# Apature Gate - Product Requirements Document

Created: 2026-06-15
Source: extracted from `apature-systems/core` PRD as of 2026-06-15.

## 1. Product Summary

Apature Gate is the GitHub-native design review product. It screenshots a pull request's preview deploy, critiques the rendered UI against the repository's design system and UI DNA, then posts an annotated GitHub review plus a Check Run.

Positioning: Applitools checks pixels; Apature Gate checks judgment.

The product is a neutral quality gate for AI-written frontend code. It judges and verifies. It does not edit code, commit fixes, or drive the customer's UI. Machine-actionable suggestions are returned so the customer's own coding agent can apply changes.

## 2. Company Role

Gate is act 1 of Apature.

It earns the trust, distribution, and data needed for the larger company:

- Trust: deterministic capture and grounded critique prove that the product sees the real UI.
- Distribution: every PR comment is a visible artifact inside the team's shipping workflow.
- Data: each finding, acceptance, rejection, and fix-then-pass outcome becomes a labeled preference example.
- Independence: the generator cannot be the judge, so Apature runs across mixed-tool teams.

## 3. Users And Buyers

Primary users:

- AI-assisted frontend developers using Cursor, Claude Code, Codex, v0, or similar tools.
- Engineering leads who need AI-generated UI to stop degrading product quality.
- Design-system maintainers who cannot manually review every AI-generated PR.

Economic buyer:

- Seed to growth engineering teams for the self-serve tier.
- Platform engineering and design-ops leaders for the hosted paid tier.

## 4. Scope

In scope for v1:

- GitHub Action for zero-infra adoption.
- GitHub App for hosted paid usage.
- Preview URL discovery from deployment webhooks, explicit action input, PR comment fallback, and local serve fallback.
- Multi-viewport screenshot capture.
- Route selection from diff, config, and framework conventions.
- Repo context extraction: tokens, brand block, component library signals, diff context.
- Qwen3-VL based triage and deep critique behind the shared `critique(images, context) -> Findings` interface.
- PR comment with annotated screenshots.
- GitHub Check Run.
- Feedback capture from explicit collaborator actions and fix outcomes.
- Advisory default, with blocking only when the repository opts in.

Out of scope:

- Functional and end-to-end testing.
- Pixel-diff regression as the primary product.
- Code edits, auto-commits, visual editing, or bundled code generation.
- Arbitrary computer-use exploration of the UI. That belongs to the `interactive-review` product.
- Agent in-loop MCP tools. That belongs to `mcp-review`, though both use the same backend interface.

## 5. MVP

The MVP must review one preview deploy per PR and return a useful, grounded design review in under two minutes for ordinary PRs.

Required capabilities:

- `action.yml` wrapping the capture and critique runner.
- Sticky PR comment with hidden marker and update-in-place behavior.
- GitHub Check Run named `design-review`.
- Capture readiness protocol using fonts ready, layout stability, animation disabling, and perceptual hash stability.
- Viewports: mobile and desktop by default, tablet configurable.
- Finding schema with dimension, severity, confidence, route, viewport, element reference, evidence, suggestion, and `introduced_by_this_pr`.
- Deterministic post-parse validation that rejects nonexistent routes or element refs.
- Feedback links that do not mutate state on GET.

## 6. Architecture

Gate owns the GitHub delivery path.

Major components:

- Trigger layer: GitHub webhooks, Action inputs, debounce, supersession, publish-time stale-SHA guard.
- Capture engine: Playwright in the user's runner for Action usage, isolated microVM capture for hosted usage.
- Repo context extractor: tokens, config, brand, diff, framework route mapping.
- Critique adapter: calls the shared Qwen3-VL critique interface.
- Delivery layer: GitHub comment, Check Run, permanent annotated image route.
- Feedback store: findings, votes, commands, fix outcomes, and model metadata.

Queue keying:

- Supersession key: `repo#pr`.
- Completed review identity: `(pr, head_sha)`.

These are intentionally different.

## 7. Data And Learning

Gate is the cleanest source of team preference data because it sits in the shipping workflow.

Signals:

- Explicit collaborator approvals, rejections, ignores, and commands.
- Implicit positive signal when the suggested token or class appears in a later diff.
- Merge outcome with unresolved findings.
- Finding drop metrics from schema and geometry validation.

Consumption:

- Per-repo memory digest appended to future reviews.
- Monthly rubric and prompt evolution through the evaluation harness.
- Long-term fine-tuning data for Apature's owned judge.

## 8. Security And Privacy

Security rules:

- No `contents: write` permission.
- Minimum GitHub App permissions: checks write, pull requests write, contents read, deployments read.
- Screenshots are sensitive and encrypted at rest.
- Paid retention may extend to 30 days under DPA; free/public tier defaults to deleting screenshots after comment publication.
- Capture only verified deployment URLs or trusted local runner URLs.
- Deny internal, link-local, metadata, and rebinding SSRF targets.
- Auth storage state is encrypted, scoped to preview origin, and disabled on fork PRs.

Neutrality rule:

- Gate never writes customer code. The no-write boundary is part of the product promise.

## 9. Success Metrics

Activation:

- Repositories with at least one successful review.
- Percentage of installs that configure a preview URL successfully.

Trust:

- False-positive rate by severity.
- Stale-review publish rate, target zero.
- Capture instability rate.

Business:

- Weekly active repositories.
- Paid conversion from Action to hosted App.
- Reviews per active repo.

Data moat:

- Labeled finding tuples per active repo.
- Accepted or resolved findings per week.

## 10. Milestones

2026-06 launch sequence:

- Week 1: capture core and CLI artifact.
- Week 2: critique core and frozen eval set.
- Week 3: GitHub Action and Marketplace listing.
- Week 4 to 6: GitHub App, hosted tier, dashboard, Stripe, and baseline comparison.

Gate does not graduate to broad paid launch until capture quality and judgment quality clear the evaluation harness.

## 11. Open Risks

- Generic critique that sounds plausible but is not useful.
- Flaky capture that critiques loading skeletons or incomplete pages.
- Preview URL heterogeneity and auth-walled deploys.
- Platform absorption by coding agents.
- Warm-pool and capture infrastructure cost for the hosted tier.

## 12. Repository Boundary

This repo owns the GitHub product surface and PR workflow. Shared model, capture, and UI DNA code can live in common packages later, but this PRD should stay focused on the buyer-facing gate.
