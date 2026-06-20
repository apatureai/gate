# Launch demo — "agent breaks the design system, caught in 90s"

The flagship demo (and the shape of the YC golden-path, #42). The video/posting
steps are human; this runbook + the scripted break are the in-repo deliverable.

## Demo repo

A small app with a clean design system (spacing scale, brand tokens, a `btn-primary`)
and a working deploy preview (Vercel `Preview`). See the golden-path repo in #42.

## The scripted break (PR)

Open a PR that subtly breaks the system — any one of:

- **Off-scale spacing:** a one-off `margin: 13px` instead of the 8px scale.
- **Hard-coded purple:** `#7C3AED` instead of the `--color-accent` token.
- **Misaligned CTA:** the primary CTA shifted off the grid.
- **Mobile overflow:** a fixed-width row that overflows the 375px viewport.

These are exactly the cases the sticky-comment severities target (#10).

## Expected result (~90s)

- Gate resolves the preview, submits the engine job, and posts the sticky comment
  + advisory Check Run.
- The comment has **at least one screenshot-grounded finding** with an annotated
  box (#12) pointing at the broken element, and a clear suggestion (use the token
  / the spacing scale).
- Time to first annotated comment is under ~90s on the demo path (the latency SLO,
  #36).

## The fix

Apply the suggested fix (use `--color-accent` / the spacing token). On the next
push, Gate re-reviews and the grade flips to `ship` → the Check Run goes green.

## Distribution (human)

- Record the 60–90s screen capture of the PR → comment → fix → green.
- Post to r/cursor, X, and HN Show. Lead with the judgment-only angle: "it never
  touches your code, it just tells you what's wrong."
