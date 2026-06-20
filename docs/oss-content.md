# Public-judgment-on-OSS content engine

A GTM loop: run Gate on **consenting** OSS preview deploys and publish the
annotated findings as shareable artifacts. This doc is the consent + opt-out
process; the publishing cadence is human-run.

## Consent (required before any run)

- Gate only reviews an OSS repo after an **explicit opt-in** from a maintainer
  (a tracked issue/PR comment or a signed form). No drive-by reviews.
- Consent is recorded with the repo, the maintainer handle, and the date.
- Consent covers publishing the resulting annotated artifacts publicly.

## What gets published

- The annotated screenshot(s) (stable `/i/<id>.png`, #12) and the finding text.
- The lineage footnote (engine/model/ui-dna version) so every published judgment
  is traceable (#10).
- Never any preview-bypass secret, storage state, or raw signed URL (redaction,
  #35).

## Opt-out

- A maintainer can opt out at any time via the same tracked channel.
- On opt-out: stop all runs for the repo and **unpublish** the artifacts —
  the stable routes are expired (410, #12) and the run rows offboarded (#52).
- Opt-out is honored within one business day and recorded with a timestamp.

## Guardrails

- Public repos only; the same fork/secret rules apply (no auth state, #35/#39).
- Findings are advisory and framed constructively — this is judgment, not a
  pull request against someone's code (no `contents: write`, ever).
