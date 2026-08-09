# Root dependency-update merge procedure

Status: archived record (2026-07-15). Dependabot and the image/SBOM CI job
were removed when the repository was archived; the serialization reasoning
below is kept because the shared-lockfile hazard it describes is real for any
fork that re-enables automated dependency updates.

The root `@gate/*` workspace has one shared `pnpm-lock.yaml`. A PR-local green
check is not sufficient evidence when another root dependency update has merged
since that PR was tested: the resulting merge can contain an invalid or stale
lockfile even when both individual candidates passed.

## Serialization rule

Dependabot may have **one** open root-workspace (`directory: "/"`) dependency
PR at a time. Dashboard and GitHub Actions updates have separate lockfiles or
no lockfile and are intentionally not part of this rule.

Do not merge a root dependency PR until all of the following are true:

1. Rebase or update the candidate onto the current `main` commit.
2. Regenerate the shared lock with the repository-pinned `pnpm@10.34.3`; never
   repair a YAML conflict by deleting lockfile mappings by hand.
3. From that rebased candidate, run `pnpm install --frozen-lockfile` followed
   by `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
4. Require the candidate's current-head CI to pass, including the image/SBOM
   lane, before merging it. Merge one root dependency update before admitting
   the next.

If a frozen install fails, stop the update sequence and repair the lock from
the manifests before merging anything else. The push-to-`main` CI workflow is
the post-merge canary; investigate any frozen-lock failure as a release and
security-evidence incident.

