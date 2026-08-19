-- 0008_carried_baselines: which commit a stored measurement set was actually
-- measured on, when the row is filed under a different one.
--
-- Every merge strategy GitHub offers puts a commit on the base branch that was
-- never any pull request's head, and Gate only ever reviewed heads. So the next
-- pull request's base was a commit nothing had measured, the lookup returned
-- `no baseline`, and `rules.measurements: block` failed nothing. When a pull
-- request merges, Gate already holds the set for the head it just reviewed, and
-- the merge commit usually carries the identical tree; copying the set onto the
-- merge commit is what gives the next pull request a base to be compared with.
--
-- NULL MEANS OBSERVED. A row with `carried_from` NULL was computed from a
-- capture of `commit_sha` itself. A row with `carried_from` set was copied from
-- that commit after GitHub's commit API reported both commits with the SAME
-- tree sha, which is what makes the copy a statement of fact rather than an
-- assertion about a rendering nobody performed. Unequal trees are never copied,
-- so this column can never name a commit whose content differs from the row's.
--
-- It is metadata, not identity: the comparison reads a carried set exactly like
-- an observed one, because identical trees render identically. The column
-- exists so an audit can tell the two apart, which a row that merely held the
-- measurements could not.

ALTER TABLE measurement_baselines
  ADD COLUMN IF NOT EXISTS carried_from text;
