Part of [gate](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Why it is interesting

**Supervising untrusted preview code is harder than `spawn()`, and there is no good public reference for it.** `packages/action/src/local-serve.ts` is that reference:

- **Process group, not process.** The child is spawned `detached` so it owns a process group; teardown is `process.kill(-pid, SIGTERM)`, a grace window, then `SIGKILL` to the survivors. Liveness is gated on the *group*, because with `shell: true` the direct child is the shell, and the shell can exit while a trapped grandchild lives on. The demo's fixture forks a worker that traps `SIGTERM` and refuses to die, so you watch this happen rather than take it on faith.
- **Default-deny environment.** Only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM`, `CI`, `NODE_ENV`, `GITHUB_WORKSPACE`, `RUNNER_OS`, `RUNNER_TEMP` and a derived `PORT` cross the boundary. Runner secrets never reach pull request code.
- **`ulimit` caps that hostile code cannot raise.** `ulimit -u` and `ulimit -v` are set hard (no `-S`) and inherited by everything the dev server forks. The capped command runs under `/bin/bash` when it exists, because `/bin/sh` on Debian and Ubuntu is dash, whose `ulimit` has no `-u`; without that detail the pids half of the cap silently does nothing on the exact runners it was written for.
- **Loopback-only readiness with redirect refusal.** The probe uses `redirect: "manual"`, and a 3xx whose `Location` leaves loopback is refused, never followed.

Three more ideas earn their keep beyond the sandbox:

- **Two identities, deliberately different.** The queue supersession key is `repo#pr` (a newer push replaces whatever is in flight). The durable identity of a *completed* review is `(repo_owner, repo_name, pr_number, head_sha)`, enforced by a unique constraint. Conflating them either double-posts or drops reviews.
- **A publish-time SHA guard that does not trust cancellation.** On a new push Gate aborts the poll and best-effort cancels the remote job, but that race can be lost. So immediately before writing to GitHub the publisher re-reads the current head SHA and discards the result if it no longer matches. Stale publishing is a correctness bug with a target rate of exactly zero, not a tunable SLO.
- **Fail closed, never fail the PR.** Every remote response is version-checked and Zod-parsed; a drifted or malformed result publishes *nothing* rather than a comment full of nulls. And no failure mode is allowed to red a pull request: every one of them ends in a neutral Check Run with an explanation.

