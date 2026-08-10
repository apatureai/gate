-- 0004_screenshot_artifacts: durable, collision-safe stable-screenshot registry
-- (#71). The hosted path keyed `/i/:id.png` by the engine's run-local `findingId`
-- (the golden fixture reuses `f_001`), so colliding ids across runs/repos could
-- resolve/authorize the wrong artifact, and there was no durable store (the route
-- couldn't survive a restart). Gate owns this metadata; screenshot BYTES and
-- critique JSON stay in verdict's encrypted bucket.
--
-- `artifact_id` is Gate-generated and globally collision-resistant
-- (sha256(installation:owner:name:head_sha:finding_id), deriveArtifactId), so it
-- is the stable-route + authorization key and is deterministic (idempotent
-- re-recording). It is intentionally NOT under the default-deny tenant RLS used
-- elsewhere: the `/i` read path serves anonymous PUBLIC artifacts and
-- capability-authorized PRIVATE artifacts, both with no tenant GUC set, so a
-- default-deny policy would break them. Tenant safety instead comes from the
-- high-entropy unguessable id + route-level authorization (visibility +
-- capability bound to artifact/tenant/repo, #61); writes, enumeration, and
-- cleanup are scoped by `installation_id` explicitly, and the installation FK
-- cascade drops a tenant's artifacts on offboarding.

CREATE TABLE IF NOT EXISTS screenshot_artifacts (
  artifact_id     text PRIMARY KEY,
  installation_id bigint  NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  repo_owner      text    NOT NULL,
  repo_name       text    NOT NULL,
  head_sha        text    NOT NULL,
  finding_id      text    NOT NULL,
  object_key      text    NOT NULL,
  visibility      text    NOT NULL CHECK (visibility IN ('public', 'private')),
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS screenshot_artifacts_installation_idx
  ON screenshot_artifacts (installation_id);
CREATE INDEX IF NOT EXISTS screenshot_artifacts_expires_idx
  ON screenshot_artifacts (expires_at);
