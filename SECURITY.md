# Security policy

## Supported versions

Gate is developed on `main`. Tags such as `v0.1.0` mark a point on `main` for
citation; they are not maintenance branches. Security fixes land on `main` only,
and the supported version is the latest commit on `main`.

| | |
|---|---|
| Supported | `main` (latest commit) |
| Not supported | forks, released tags once `main` has moved past them, and any commit other than the current `main` |
| Private reporting | enabled, see below |
| Bug bounty | none |

## Reporting a vulnerability

**Report privately. Do not open a public issue for a vulnerability.**

Use **GitHub private vulnerability reporting** on this repository: the *Security*
tab → *Report a vulnerability*. That opens a private advisory visible only to the
maintainers.

Include what you would want to receive: affected file or path, the version or
commit, what an attacker gains, and the smallest reproduction you can manage. A
failing test against this repository is the most useful form.

What to expect:

- **Acknowledgement within 3 business days.** If you have not heard back by then,
  ping the advisory thread.
- **An assessment within 10 business days**, saying whether it is accepted, the
  severity we think it is, and roughly when a fix will land.
- **A fix on `main`** for accepted reports, and a GitHub Security Advisory
  published from the private report once the fix is out.
- **Credit** in the advisory under whatever name or handle you prefer, unless you
  ask to stay anonymous.
- **Coordinated disclosure.** Please give us 90 days before publishing, or less
  if the issue is already public or being exploited. If we go quiet past the
  windows above, publish; a silent maintainer is not a reason to sit on a
  vulnerability.

Reports about a dependency's known advisory are better filed as normal public
issues, since they are already disclosed upstream. The current state of the
dependency tree is the next section.

## Dependency advisories

Both dependency trees audit clean as of **2026-08-10**, on macOS 15.6 with
Node 24.14.0, pnpm 10.34.3 and npm 11. Reproduce it in two commands from a clean
clone:

```
pnpm install --frozen-lockfile && pnpm audit
No known vulnerabilities found

cd apps/dashboard && npm ci && npm audit
found 0 vulnerabilities
```

`apps/dashboard` is audited separately on purpose: it is outside the pnpm
workspace (`pnpm-workspace.yaml` covers `packages/*` only) and is built with npm
against its own `package-lock.json`, so a root `pnpm audit` never sees it. Run
both.

### What was open, and what closed it

Eleven advisories were open on 2026-08-09: seven at the root (1 moderate,
6 high) and four in the dashboard (all high). Every one was fixable by upgrading
inside the existing semver range, so nothing here is a suppression.

| Package | Where | Advisory | Fixed by |
|---|---|---|---|
| `find-my-way` | root, runtime, via `fastify` in `packages/service` | GHSA-c96f-x56v-gq3h | `fastify` `^5.10.0` to `^5.11.3`, which resolves `find-my-way` 9.7.0 |
| `fast-uri` (x2) | root, runtime, via `fastify` > `@fastify/ajv-compiler` | GHSA-v2hh-gcrm-f6hx, GHSA-7p8r-x3mc-p8w7 | same bump; `@fastify/ajv-compiler` 4.0.6 moved to `fast-uri` `^4.0.0`, out of the affected 3.x range |
| `postcss` | root, dev only, via `vitest` > `vite` | GHSA-fxqj-rqcc-2cmp | lockfile refresh to 8.5.26 |
| `nanoid` | root, dev only, via `postcss` | GHSA-2v37-7h3g-55p8 | same refresh, to 3.3.18 |
| `brace-expansion` (x2) | root, dev only, via `eslint` > `minimatch` | GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895 | pinned override, see below |
| `next` (9 advisories) | dashboard | see `npm audit` for the list | `next` `^16.2.10` to `^16.3.0` |
| `postcss`, `nanoid`, `sharp` | dashboard, via `next` | GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849, GHSA-fxqj-rqcc-2cmp, GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, GHSA-f88m-g3jw-g9cj (libvips CVE-2026-33327, -33328, -35590, -35591) | the same `next` bump: 16.3.0 pins `postcss` 8.5.23 and `sharp` `^0.35.3` |

Two pins are load-bearing and should not be removed casually:

- **`minimatch>brace-expansion: ^5.0.9`** in `pnpm-workspace.yaml`. `eslint`'s
  `minimatch` asks for `^5.0.5` and resolves to a vulnerable 5.0.7 on its own.
  The override is scoped to the `minimatch` edge rather than applied globally,
  so a future consumer that legitimately needs `brace-expansion` 1.x or 2.x is
  not forced onto 5.x.
- **No `overrides` block in `apps/dashboard/package.json`.** There used to be a
  `postcss: 8.5.10` pin there, added to clear an earlier advisory. It became the
  thing holding `postcss` *below* the patched line, because `next` 16.3.0 already
  depends on the patched 8.5.23 exactly. Removing the override was the fix.
  If you add one back, check it against `npm view next@<version> dependencies`
  first.

### What is not enforced

Nothing fails CI on a *new* advisory. These numbers are a snapshot taken by hand
and they will drift. Dependabot opens the bumps, but the audit gate that would
turn a fresh advisory red is roadmap item 5, and the container-image half of it
is item 10. Until those land, re-audit before you deploy rather than trusting
this page.

## Things that are intentional, not vulnerabilities

- **Gate never requests `contents: write` and never edits code.** Check Runs are
  advisory unless a repository opts into blocking mode. A report that Gate
  "cannot fix the issue it found" is describing the design.
- **The Action path constrains untrusted pull request code but does not sandbox
  it.** See the next section; this is documented, gated, and on the roadmap.
- **The resource cap is Linux-only.** `ulimit -v` does not apply on macOS, and
  the demo reports `applied  no` there honestly.

## Before you run this against anything real

Gate is a GitHub App and GitHub Action that handles other people's repositories
and secrets. Read the code before you point it at production.

- **It wants real, high-value credentials.** The App path expects a GitHub App ID
  and private key, a webhook secret, KMS key material, critique-service API and
  HMAC secrets, screenshot and feedback token secrets, and Stripe keys. Provision
  throwaway credentials in a throwaway installation first. Do not reuse a GitHub
  App private key that has access to repositories you care about.
- **It depends on a service you supply.** Gate calls out over HTTP for browser
  capture and the model critique. That service is not in this repository, and
  anything you wire up in its place inherits the trust Gate places in it. The
  contract is `packages/types`; the transport seam is `createHttpEngineTransport`.
- **The Action path renders untrusted PR code in your runner.** Capturing a
  preview means code from the pull request runs inside your own CI environment.
  The residual risk, and the mitigations Gate does and does not provide, are
  written up under "Threat model: Action-path hostile-PR capture" in
  [`README.md`](README.md). Read that section before enabling the Action path on
  a repository that accepts fork pull requests. Do not run it on
  `pull_request_target` with repository secrets in scope.
- **Audit the dependency tree yourself.** Both trees were clean on 2026-08-10
  (see [Dependency advisories](#dependency-advisories)), but no CI job keeps
  them that way, so that statement ages. Run `pnpm audit` at the root and
  `npm audit` in `apps/dashboard` before deploying.
