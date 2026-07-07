-- 0001_init: Gate durable product state (TRD §5, §9, §12; §15.4/§15.5/§15.6).
-- Idempotent: every object uses IF NOT EXISTS so re-applying is a no-op.
-- Gate stores only metadata, correctness state, and billing. Screenshots,
-- critique JSON, and the preference dataset live in judgment-engine object
-- storage, never here.

-- GitHub App installations (one per account that installs Gate).
CREATE TABLE IF NOT EXISTS installations (
  id            bigint PRIMARY KEY,            -- GitHub installation id
  account_login text   NOT NULL,
  account_id    bigint NOT NULL,
  account_type  text   NOT NULL DEFAULT 'Organization',
  token_ref     text,                          -- KMS reference, never the token itself
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Completed reviews. 0003 replaces this initial global identity with the
-- repository-scoped TRD §5 identity (repo_owner, repo_name, pr_number, head_sha).
CREATE TABLE IF NOT EXISTS runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id     bigint  NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  repo_owner          text    NOT NULL,
  repo_name           text    NOT NULL,
  pr_number           integer NOT NULL,
  head_sha            text    NOT NULL,
  grade               text,
  engine_version      text,
  model               text,
  ui_dna_version      text,
  depth               text,
  last_full_review_at timestamptz,             -- durable 10-min full-review cap (§15.3)
  expires_at          timestamptz,             -- retention / offboarding (§15.5)
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runs_pr_head_sha_key UNIQUE (pr_number, head_sha)
);
CREATE INDEX IF NOT EXISTS runs_repo_pr_idx ON runs (repo_owner, repo_name, pr_number);

-- Product-facing feedback events (TRD §9). GET requests must never write here.
CREATE TABLE IF NOT EXISTS feedback_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id       bigint  NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  run_id                uuid    REFERENCES runs(id) ON DELETE SET NULL,
  type                  text    NOT NULL,
  repo_owner            text    NOT NULL,
  repo_name             text    NOT NULL,
  pr_number             integer NOT NULL,
  head_sha              text    NOT NULL,
  finding_id            text,
  actor_login           text,
  actor_is_collaborator boolean,
  metadata              jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_events_run_idx ON feedback_events (run_id);

-- Billing state (Stripe). One row per installation.
CREATE TABLE IF NOT EXISTS billing_customers (
  installation_id    bigint PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  stripe_customer_id text,
  plan               text NOT NULL DEFAULT 'free',
  status             text NOT NULL DEFAULT 'active',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Webhook delivery dedupe for at-least-once delivery (§15.4, #49).
CREATE TABLE IF NOT EXISTS webhook_log (
  delivery_id text PRIMARY KEY,                 -- X-GitHub-Delivery
  event       text,
  received_at timestamptz NOT NULL DEFAULT now()
);
