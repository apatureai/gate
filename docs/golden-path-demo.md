# YC golden-path demo repo + <90s smoke test

The demo-as-test (TRD §14): a golden-path repo that proves the core promise on a
schedule — an annotated review in under 90s, and a green Check Run after the fix.

## Demo repo

- A clean design system (8px spacing scale, brand tokens incl. `--color-accent`,
  a `btn-primary`) with a working Vercel `Preview` deploy.
- Lives at the org's `gate-golden-path` repo (the live target for the scheduled
  smoke test).

## The scripted path

1. A scripted PR introduces a subtle break (off-scale spacing / hard-coded purple
   / misaligned CTA / mobile overflow — see docs/launch-demo.md).
2. Gate posts an annotated PR review in **under 90 seconds** with **at least one
   screenshot-grounded finding**.
3. The fix is applied; a re-run flips the Check Run to **passing**.

## Automated smoke test

- In CI (`@gate/e2e` `golden-path.test.ts`) the full Action path runs against the
  **mock engine** and asserts: an annotated review with ≥1 finding, the review
  completes within the 90s budget, and the post-fix re-run yields a `success`
  Check Run. No live model calls.
- A **scheduled** smoke test runs the same flow against the **live pipeline**
  (cron) and alerts if the first annotated comment exceeds 90s or the Check Run
  doesn't flip — this scheduled live run is an ops wiring step.
