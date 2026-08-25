Part of [gate](../README.md). Moved from the README on 2026-08-24; anchors preserved.

### Threat model: Action-path hostile-PR capture

On the Action path, capture runs inside **your** runner, which means attacker-authored code from a fork pull request executes on a network with reachable internal services. This is the same class of risk as any "build untrusted PR code in CI" step, but rendering a page makes it explicit.

**Why the App path differs.** On the App path, capture does not run in your runner: Gate hands the verified preview URL to the critique service, which is where the isolation belongs. The companion `verdict` service is specified to capture inside a Firecracker microVM with an egress policy, internal-IP deny and DNS-rebind rechecks. The Action path cannot offer that isolation, because the runner is yours.

**Gate-owned (this repository):**

- **Provenance.** A preview URL is forwarded only from a verified origin: `deployment_status`, explicit input, `url_template`, an allowlisted provider-bot comment, or local serve. Free-text URLs are rejected as `unverified_preview_source` (`verifyPreviewHandoff`). A default-branch push resolves its URL from `preview.default_branch_url`, which is an operator-supplied literal in the repository's own config and is verified through the same guard as `explicit` before any capture is asked for.
- **Fork gating.** `storageState`/auth and preview-bypass secrets are disabled on fork pull requests *before* any capture or handoff. Local serve is disabled on forks unless the repository opts in with `preview: { fork_preview: true }`. "Is this a fork" prefers GitHub's own `head.repo.fork` and falls back to comparing the two repository names; a payload that answers neither is treated as a fork, since the alternative is a gate that opens whenever it cannot see.
- **Least privilege.** The Action requests no `contents: write` (`GATE_GITHUB_PERMISSIONS`); it posts comments and Check Runs only.
- **Containment of the local server.** Environment allowlist, `ulimit` caps, loopback-only, redirect refusal, guaranteed teardown. The quickstart demonstrates every one of them live. "Loopback-only" means the whole of `127.0.0.0/8`, `localhost` and `::1`, matched as addresses. It used to mean, in one of the two places that check it, any hostname *beginning* `127.` — which `127.evil.example.com` does, while resolving wherever its owner points it. Both places now hold the same line.

**Engine-owned (whatever critique service you wire in):** sandbox egress policy, internal-IP egress deny, SSRF protection, DNS-rebind rechecks, screenshot encryption and retention, prompt-injection controls. Gate does not duplicate these; on the Action path they are simply unavailable, which is why the residual risk is gated and documented rather than eliminated.

**Operator guidance.** Do not run capture on `pull_request_target` (or a fork-triggered `workflow_run`) with repository secrets in scope: it runs in the base repository's context, with secrets, while checking out fork code, which is the worst combination. Use the default `pull_request` trigger. For untrusted forks prefer the App path, where capture happens outside your runner. Treat the runner as compromisable and minimise what it can reach.

