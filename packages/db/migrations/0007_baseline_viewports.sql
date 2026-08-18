-- 0007_baseline_viewports: which viewports a stored measurement set was measured
-- at, so a severity band recorded on the base is comparable to one measured now.
--
-- A band is the worst measurement across the viewports a run looked at, and
-- measurement identity excludes the viewport on purpose: a violation that used
-- to show only at mobile and now also shows at desktop is the same violation.
-- Those two facts together mean a repository that widens its `viewports:` config
-- measures the same markup somewhere the base run never visited, the worst band
-- rises, and byte-identical HTML reads as a regression the pull request caused.
--
-- NULLABLE, AND NULL IS NOT AN EMPTY LIST. A row written before this column
-- existed does not know which viewports it covered, and the comparison reads
-- that as unknown and declines to compare bands at all. Defaulting it to '[]'
-- would assert that those runs measured nothing, which is a claim no stored row
-- supports. Unknown never gates, which is the same rule an absent band and an
-- absent baseline already follow.

ALTER TABLE measurement_baselines
  ADD COLUMN IF NOT EXISTS viewports_measured jsonb;
