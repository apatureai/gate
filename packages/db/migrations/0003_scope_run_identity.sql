-- 0003_scope_run_identity: make the completed-review identity repository-scoped.
--
-- PR numbers are local to a repository, and the same commit SHA can appear in
-- forks or repositories with shared history. The original global
-- UNIQUE(pr_number, head_sha) could therefore reject an unrelated repository's
-- completed review.

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_pr_head_sha_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'runs_repo_pr_head_sha_key'
       AND conrelid = 'runs'::regclass
  ) THEN
    ALTER TABLE runs
      ADD CONSTRAINT runs_repo_pr_head_sha_key
      UNIQUE (repo_owner, repo_name, pr_number, head_sha);
  END IF;
END
$$;
