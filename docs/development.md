Part of [gate](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint        # eslint --max-warnings=0
pnpm typecheck   # tsc -b across all project references
pnpm test        # vitest
pnpm build       # tsc -b, emits dist/
```

One file at a time: `pnpm exec vitest run packages/action/test/local-serve.test.ts`.

There are no live model calls and no live network in the suite; the critique service is always mocked, including in the `@gate/e2e` acceptance harness. Keep that rule. The suites that boot PGlite (in-process WASM Postgres) are slow enough to race vitest's default 5s/10s timeouts on a loaded machine, so `vitest.config.ts` raises `testTimeout` and `hookTimeout` to 30s; do not lower them.

`packages/e2e/test/golden-path.test.ts` is the demo-as-test: the full Action path against a mock engine, asserting an annotated, screenshot-grounded review in under 90 seconds and a green Check Run after the fix.

`apps/dashboard` is **not** part of this root gate. The Next.js shell keeps its own React/Next tree, its own `package-lock.json`, and is built with its own isolated `next build` CI job:

```bash
pnpm build
cd apps/dashboard
npm ci
npm run build
```

`next build` rewrites `apps/dashboard/next-env.d.ts` and reformats `apps/dashboard/tsconfig.json` (it adds the generated route types and flips `jsx` to `react-jsx`). Both files are committed **in their post-build form**, so a build on a clean tree leaves `git status` clean; if you upgrade Next, expect one commit of regenerated churn.

### Regenerating the architecture poster

`gate_architecture.png` is a screenshot of `poster_gate.html`, which is designed at exactly 3020x2018. Edit the HTML, then re-shoot it with headless Chrome, from the repository root:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=3020,2018 --virtual-time-budget=4000 \
  --screenshot="$PWD/gate_architecture.png" "file://$PWD/poster_gate.html"
```

On Linux use `google-chrome` or `chromium` in place of the macOS path. The render is deterministic: re-shooting an unedited `poster_gate.html` reproduces the committed PNG byte for byte, so `git status` stays clean unless you actually changed the poster. Keep the window size, or the poster is cropped rather than scaled.

More in [`CONTRIBUTING.md`](../CONTRIBUTING.md): conventions, the three edits adding a package requires, and the two Postgres details that cost real time.

### Regenerating the README hero

The hero (`docs/assets/hero.png`) is the real `pnpm demo:review` output — `out/review-comment.md` rendered as a GitHub comment beside `out/annotated-f_001.png`. No bytes are invented; the comment is read verbatim from the demo's output. It is rebuilt with a headless Chromium (the same one `verdict`'s checkout installs via `pnpm browser:install`; point `GATE_PLAYWRIGHT_CORE` at another `playwright-core` install if yours lives elsewhere):

```bash
pnpm demo:review                        # writes ./out (review-comment.md, annotated-f_001.png)
cp out/review-comment.md docs/assets/hero-transcript.txt
node scripts/hero/build-hero.mjs        # writes docs/assets/hero.png
cp out/annotated-f_001.png docs/assets/gate_review_demo.png
```

`docs/assets/hero-transcript.txt` is the raw comment the image renders, committed so the hero is diffable against a re-run. The two SVG banners (`docs/assets/banner-light.svg`, `banner-dark.svg`) are hand-authored typographic files, not generated.

### Releases

Changes are recorded in [`CHANGELOG.md`](../CHANGELOG.md). Gate ships as a Docker-based GitHub Action, not on npm — every workspace package is `private: true` — so a release is a `vX.Y.Z` git tag with a matching GitHub release, and the moving major tag `v1` is re-pointed at the newest `v1.x` so `uses: apatureai/gate@v1` resolves to it.

