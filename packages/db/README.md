# @gate/db

Gate's durable product state: Postgres schema + an idempotent migration runner.

Gate stores **metadata, correctness state, and billing only**. Screenshots,
critique JSON, and the preference dataset live in Verdict's object
storage, never here.

## Tables

- `installations`: GitHub App installations (account + KMS token reference).
- `runs`: completed reviews, keyed by the completed-review identity
  `UNIQUE(repo_owner, repo_name, pr_number, head_sha)`; carries `grade`,
  `engine_version`, `model`, `ui_dna_version`, `last_full_review_at`,
  `expires_at`. The queue supersession key remains `repo#pr`.
- `measurement_baselines`: the measurement set observed for a repository at a
  commit, keyed `UNIQUE(repo_owner, repo_name, commit_sha)`. This is what lets a
  pull request be told apart from its own back catalogue: a violation in the set
  stored for the PR's base is pre-existing, one absent from it was introduced by
  the PR. No row for a base commit means Gate has never
  measured it, which is reported as "no baseline" and never as a clean base.
  Stores the check kind and route in the clear and the element/detail identity as
  SHA-256 digests, so no selector or engine sentence is kept. Each entry may also
  carry the engine's ordinal `severity` band, which is what lets a violation that
  was already on the base be shown to have got materially worse. It lives inside
  the existing `entries` jsonb, so it needed no migration and no identity bump,
  and an entry stored without one reads as unknown and gates on nothing.
- `feedback_events`: product-facing feedback.
- `billing_customers`: Stripe/plan state.
- `webhook_log`: `delivery_id` PK for at-least-once webhook dedupe (§15.4).

## Migrations

SQL files in `migrations/` (`NNNN_*.sql`) are applied once each, in filename
order, tracked in `schema_migrations`. The runner is idempotent, so it is safe
to run on every deploy.

```ts
import { Pool } from "pg";
import { pgExecutor, runMigrations } from "@gate/db";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await runMigrations(pgExecutor(pool));
```

Or via the CLI (used as the Fly release command in #32):

```sh
DATABASE_URL=postgres://... pnpm --filter @gate/db migrate
```

## Provisioning (ops)

Provision a managed Postgres (Neon or Fly Postgres) and expose its connection
string as `DATABASE_URL` to the service and to the deploy release step. Tenant
row-level-security policies are added in #50. CI exercises the runner against an
embedded PGlite instance, so the migration path is tested without a live DB.
