-- 0009_baseline_environment: where a stored measurement set was RENDERED, so a
-- comparison can tell whether its two sides are comparable at all.
--
-- Until a push could record a baseline, both sides of every comparison were
-- rendered at a pull request's preview deployment, and the only thing that could
-- differ between them was the pull request. A set measured at
-- `preview.default_branch_url` broke that: for most teams that URL is
-- production, and production differs from a preview in ways no pull request
-- caused (seed data, feature flags, a signed-out state, a consent banner, a
-- different CDN). A violation one side renders and the other does not matches
-- nothing, is called INTRODUCED, and under `rules.measurements: block` fails a
-- build that broke nothing.
--
-- TWO COLUMNS, AND ONLY THE FIRST IS EVER MATCHED ON. `surface` is the KIND of
-- deployment: `pull_request_preview` or `default_branch`. That is the
-- granularity the question has. `origin` is the address, kept for audit and for
-- one narrow positive signal (two sides at the same address are one deployment).
-- It is never a matching condition on its own: preview origins differ per pull
-- request by construction, so a rule of the form "the origins must match" would
-- refuse every comparison Gate has ever made.
--
-- NULLABLE, AND NULL IS UNKNOWN RATHER THAN A DIFFERENCE. A row written before
-- this column existed cannot be shown to have been rendered somewhere else, and
-- the comparison reads that as unknown and compares normally. The opposite
-- reading would have switched attribution off for every baseline in the field on
-- the day this shipped. Same rule as an absent engine version, an absent
-- severity band and an absent viewport list already follow.
--
-- A CARRIED ROW KEEPS THE SURFACE OF THE RENDERING IT DESCRIBES. `carried_from`
-- says which commit was rendered; this says where. Copying a set across two
-- identical trees does not move it to another deployment, and that is exactly
-- why a carried set is the better baseline: it was rendered at a preview, and
-- the pull request it will be compared against is measured at one too.

ALTER TABLE measurement_baselines
  ADD COLUMN IF NOT EXISTS measured_at_surface text,
  ADD COLUMN IF NOT EXISTS measured_at_origin text;
