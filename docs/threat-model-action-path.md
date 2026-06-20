# Threat model — Action-path hostile-PR capture

Spec: TRD §2, §8, §15.5; ARCHITECTURE §4 (D3). Scope: the **Action path**, where
capture runs inside the customer's own GitHub runner. This document is the
mitigation for a residual risk that is inherent to capturing in the customer
runner; the fix is provenance + fork gating + documentation, not a Gate-side
sandbox.

## The threat

On the Action path, rendering a PR's preview means a browser (Playwright)
loads attacker-influenced application code:

- A pull request can change the app served at the preview URL, including client
  and (for a local-serve preview) server code that runs during capture.
- That code executes in the capture browser **inside the customer's runner**,
  which typically sits on a network with reachable internal services (metadata
  endpoints, other CI services, private hosts).
- Hostile PR code could therefore probe runner-internal networks, attempt SSRF,
  or try to read anything the runner process or browser can reach.

This is the same class of risk as any "build/test untrusted PR code in CI" step;
Gate does not make it worse, but capturing a *rendered page* makes it explicit.

## Why the App path differs

On the **App path**, capture does not run in the customer runner. Gate hands the
verified preview URL to `judgment-engine`, which captures inside a **Firecracker
microVM sandbox** with an egress policy, internal-IP deny, and DNS-rebind
rechecks. The blast radius of hostile page code is contained to a throwaway VM
with no access to customer or Gate networks. The Action path cannot offer that
isolation because the runner is the customer's.

## Ownership boundary

**Gate-owned (this repo):**

- **Provenance.** A preview URL is forwarded to the engine only from a verified
  origin (`deployment_status`, explicit input, `url_template`, allowlisted
  provider-bot comment, or local-serve); free-text/off-domain URLs are rejected
  as `unverified_preview_source` (`verifyPreviewHandoff`, #39).
- **Fork gating.** `storageState`/auth and preview-bypass secrets are disabled on
  fork PRs **before any capture or handoff** (`storageStateForPr`, #35; enforced
  in `verifyPreviewHandoff`, #39).
- **Least privilege.** The Action requests no `contents: write`
  (`GATE_GITHUB_PERMISSIONS`); it posts comments + check runs only.

**Engine-owned (`judgment-engine`):**

- Sandbox egress policy, internal-IP egress deny, SSRF protection, DNS-rebind
  rechecks, screenshot encryption/retention, prompt-injection controls.

Gate does **not** duplicate the engine's network-layer controls; on the Action
path those controls are simply not available, which is why the residual risk is
documented and gated rather than eliminated.

## Operator guidance (must follow)

- **Do not run capture on `pull_request_target`** (or `workflow_run` triggered by
  forks) with repository secrets in scope. `pull_request_target` runs in the
  base repo's context with secrets available, while checking out fork code — the
  worst combination for hostile-PR execution. Use the default `pull_request`
  trigger, which runs without secrets for fork PRs.
- Prefer the **App path / `deployment_status`** review for untrusted forks, so
  capture happens in the engine sandbox rather than your runner.
- Keep preview-bypass tokens and `storageState` in secrets that are **not**
  exposed to fork PR runs; Gate disables them on forks, but defense-in-depth
  starts with not granting them.
- Treat the runner as compromisable when reviewing untrusted forks: minimize the
  secrets and network reachability available to the job.
