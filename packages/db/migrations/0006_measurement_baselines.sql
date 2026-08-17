-- 0006_measurement_baselines: the measurement set a repository had at a commit,
-- so a pull request can be told apart from its own back catalogue.
--
-- Without this table every run reports every measured violation on every page it
-- captured. As advisory output that is noise; as a merge gate it is unusable,
-- because the first pull request after installation inherits every pre-existing
-- contrast failure in the repository and the team turns the tool off. Storing
-- the set per commit is what makes "introduced by this pull request" a
-- statement Gate can support.
--
-- IDENTITY. `fingerprint_version` stamps the normalization the entries were
-- computed under (`measurement-identity.ts`). It is stored rather than assumed
-- so a future change to what counts as "the same violation" is DETECTED and
-- refused, instead of silently reporting a whole repository as new.
--
-- WHAT IS IN `entries`. One object per violation: `kind` and `route` in the
-- clear, and the element/detail identity as two salt-free SHA-256 digests
-- (`elementKey`, `fingerprint`). Gate stores metadata only, and a selector and
-- an engine sentence both derive from the customer's page; neither has to be
-- kept to answer "is this the same violation as last time". `kind` and `route`
-- stay readable because a fixed violation has to be scoped to the pages this run
-- actually measured, and a digest cannot be scoped.
--
-- `checks_run` and `routes_measured` are what make an EMPTY `entries` mean
-- something: with a non-empty `checks_run` it is the positive claim "these
-- checks ran on these routes and found nothing", which is the only way a
-- violation can honestly be called new. With an empty `checks_run` it means
-- nothing was measured, and nothing is classifiable.

CREATE TABLE IF NOT EXISTS measurement_baselines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id     bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  repo_owner          text   NOT NULL,
  repo_name           text   NOT NULL,
  commit_sha          text   NOT NULL,
  fingerprint_version text   NOT NULL,
  engine_version      text,
  checks_run          jsonb  NOT NULL DEFAULT '[]'::jsonb,
  routes_measured     jsonb  NOT NULL DEFAULT '[]'::jsonb,
  entries             jsonb  NOT NULL DEFAULT '[]'::jsonb,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT measurement_baselines_repo_commit_key UNIQUE (repo_owner, repo_name, commit_sha)
);

CREATE INDEX IF NOT EXISTS measurement_baselines_installation_idx
  ON measurement_baselines (installation_id);
CREATE INDEX IF NOT EXISTS measurement_baselines_repo_idx
  ON measurement_baselines (repo_owner, repo_name);

-- Same default-deny tenant isolation as `runs` (0002): the transaction-local
-- GUC `app.current_installation_id` reads NULL when unset, so a query with no
-- tenant context sees nothing. A baseline is per-repository product state, not a
-- public artifact, so unlike `screenshot_artifacts` it has no anonymous read
-- path and no reason to sit outside RLS.
ALTER TABLE measurement_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_baselines FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS measurement_baselines_tenant_isolation ON measurement_baselines;
CREATE POLICY measurement_baselines_tenant_isolation ON measurement_baselines
  USING (installation_id = nullif(current_setting('app.current_installation_id', true), '')::bigint)
  WITH CHECK (installation_id = nullif(current_setting('app.current_installation_id', true), '')::bigint);
