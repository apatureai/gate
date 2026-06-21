-- 0005_feedback_consumed_tokens: durable single-use enforcement for feedback
-- vote tokens (#13/#41 follow-up; CSO finding). The one-time `jti` was only
-- tracked in-process (createInMemoryConsumedStore), so a multi-instance deploy
-- or a restart let a still-unexpired feedback token be replayed on another
-- instance. This table makes "consume" atomic and cluster-wide via a PK + an
-- INSERT ... ON CONFLICT DO NOTHING (first insert wins; a replay conflicts and
-- is rejected). Tokens also carry their own `exp`, so a periodic prune of rows
-- older than the max token lifetime keeps this table bounded.
CREATE TABLE IF NOT EXISTS feedback_consumed_tokens (
  jti         text PRIMARY KEY,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_consumed_tokens_consumed_at_idx
  ON feedback_consumed_tokens (consumed_at);
