# Security policy

**This project is archived and unmaintained. There is no active security support.**

Apature Gate was a commercial product that has been wound down and released as a
public archive. No one is monitoring this repository for vulnerabilities, no
patches will be issued, and there are no supported versions.

| | |
|---|---|
| Supported versions | none |
| Security patches | none; no fixes, backports, or releases are planned |
| Bug bounty | none; there is no bounty program and no reward for reports |
| Response time | none guaranteed; reports may not be read |

## Reporting a vulnerability anyway

If you find something and want it on the record:

1. Use **GitHub private vulnerability reporting** on this repository (Security tab
   → "Report a vulnerability"), if it is available.
2. There is no monitored channel behind it. Please also publish your finding where
   downstream users will actually see it (a public advisory database, or a note in
   your fork) rather than waiting for a reply here.

Do not expect an acknowledgement, a CVE, or a fix. Reports are accepted as a
courtesy to whoever forks this code next, not as an obligation.

## If you plan to run this code

This repository is a full GitHub App and GitHub Action that handles other
people's repositories and secrets. Treat it as unreviewed third-party code and
read it before you point it at anything real.

Specific things to check before running it against production:

- **It wants real, high-value credentials.** The App path expects a GitHub App ID
  and private key, a webhook secret, KMS key material, judgment-engine API/HMAC
  secrets, screenshot and feedback token secrets, and Stripe keys. Provision
  throwaway credentials in a throwaway installation first. Do not reuse a GitHub
  App private key that has access to repositories you care about.
- **It is incomplete on its own.** Gate calls a separate `judgment-engine`
  service for browser capture and model critique. That service is not in this
  repository. Anything you wire up in its place inherits the trust Gate places
  in it.
- **The Action path renders untrusted PR code in your runner.** Capturing a
  preview means a browser loads code from the pull request, inside your own CI
  environment. The residual risk and the mitigations Gate does and does not
  provide are written up under "Threat model: Action-path hostile-PR capture"
  in [`README.md`](README.md). Read that section before enabling the Action path
  on a repository that accepts fork PRs.
- **Dependencies are frozen at archive time.** `pnpm-lock.yaml` and the base
  images reflect the last maintained state, not today's. While the project was
  maintained, CI generated SBOMs and failed the build on fixable
  medium-or-higher vulnerabilities in the shipped images; that job was removed
  when the repository was archived, because it gated on base-image CVE drift and
  would have gone permanently red. Re-audit and update before deploying.
- **Known design boundaries are intentional, not bugs.** Gate never requests
  `contents: write` and never edits code; Check Runs are advisory unless a repo
  opts into blocking. If a fork changes either, it is no longer the reviewed
  system described in these docs.
