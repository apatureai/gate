/**
 * Is this pull request from a fork?
 *
 * The answer decides whether preview-bypass and `storageState` secrets are
 * disabled before handoff, and whether the repository's `preview-command` is
 * allowed to run untrusted code on the runner. So the interesting case is not
 * the ordinary one, which either form of the check gets right; it is the case
 * where the event payload does not say. The check this replaced compared the
 * two `full_name`s and answered `false` whenever either was missing, which is
 * the permissive answer: unknown provenance was read as "same repository", and
 * everything a fork is gated out of was gated back in.
 *
 * Unknown now means fork. That costs a same-repository pull request nothing,
 * because GitHub always sends `base.repo` and sends `head.repo` for every open
 * pull request whose head still exists; the payloads that reach the null case
 * are the ones whose head repository was deleted, and there is no branch left
 * there to build.
 */
export interface ForkPullRequestPayload {
  head: { repo?: { full_name?: string; fork?: boolean } | null };
  base: { repo?: { full_name?: string } | null };
}

export function isForkPullRequest(pr: ForkPullRequestPayload): boolean {
  // GitHub's own answer, when it sent one. A repository knows whether it is a
  // fork; comparing names is the inference for when it did not say.
  if (typeof pr.head.repo?.fork === "boolean") return pr.head.repo.fork;
  const head = pr.head.repo?.full_name;
  const base = pr.base.repo?.full_name;
  if (!head || !base) return true;
  return head !== base;
}
