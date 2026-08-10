# @gate/db

Gate's durable product state: Postgres schema + an idempotent migration runner.

Gate stores **metadata, correctness state, and billing only**. Screenshots,
critique JSON, and the preference dataset live in `judgment-engine` object
storage, never here.

## Tables

- `installations`: GitHub App installations (account + KMS token reference).
- `runs`: completed reviews, keyed by the completed-review identity
  `UNIQUE(repo_owner, repo_name, pr_number, head_sha)`; carries `grade`,
  `engine_version`, `model`, `ui_dna_version`, `last_full_review_at`,
  `expires_at`. The queue supersession key remains `repo#pr`.
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
