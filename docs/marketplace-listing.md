# GitHub Marketplace listing — Apature Gate

GTM tracking + assets for the Marketplace listing (start week 1). The listing
draft and verification are not blocked on the judgment-engine quality gate — the
listing can go to draft/review while the engine matures.

## Listing copy

- **Name:** Apature Gate
- **Tagline:** Judgment-only design review for your PR previews.
- **Categories:** Code review, CI, Quality.
- **Description:** Gate renders your PR's preview deployment and posts an
  annotated, screenshot-grounded design review as a sticky comment + advisory
  Check Run. It catches design-system breaks (off-scale spacing, off-brand color,
  mobile overflow, misaligned CTAs) in ~90s. Gate is judgment-only — it never
  edits your code.

## Permissions (the neutrality guarantee)

Requests **only** `checks: write`, `pull_requests: write`, `contents: read`,
`deployments: read` — **never `contents: write`** (see `@gate/service`
`GATE_APP_PERMISSIONS`, #21). Lead with this in the listing: a reviewer that
cannot write code cannot be coerced into changing it.

## Events

`pull_request`, `deployment_status`.

## Pricing

$20 / developer / month (#19). Free tier: public repos, triage plus one deep
review per PR.

## Assets to prepare

- App logo + feature card.
- 3–5 screenshots: sticky comment, annotated finding, Check Run, dashboard run
  history, config UI.
- Demo video (see docs/launch-demo.md).

## Verification checklist

- [ ] Publisher verification (org domain verified).
- [ ] Marketplace security/permissions review (minimal scopes above).
- [ ] Support + privacy policy URLs (data processor; see offboarding #52).
- [ ] Pricing plan configured in Marketplace + Stripe (#19).
- [ ] Listing status tracked weekly; not gated on the engine quality gate.
