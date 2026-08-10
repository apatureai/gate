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

Reports about a dependency's known advisory (the ones already listed in the
README roadmap) are better filed as normal public issues, since they are already
disclosed upstream.

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
- **Audit the dependency tree yourself.** `pnpm audit` at the root and
  `npm audit` in `apps/dashboard` both report open advisories today; the current
  counts and the exact packages are in the README roadmap. Re-audit and update
  before deploying.
