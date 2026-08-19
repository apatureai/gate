import {
  baselineSupersedes,
  carryMeasurementBaselineForward,
  type MeasurementBaselineStore,
} from "@gate/delivery";

/**
 * Carry a measurement set from a reviewed head onto the commit its merge put on
 * the base branch.
 *
 * WHY THIS EXISTS. Gate scopes measured violations against the set stored for a
 * pull request's BASE commit, and sets were only ever recorded for a pull
 * request's HEAD. Every merge strategy GitHub offers puts a commit on the base
 * branch that was never any pull request's head, so the next pull request's base
 * was a commit Gate had never measured, the lookup returned `no baseline`, and
 * `rules.measurements: block` failed nothing. It worked on stacked pull requests
 * and nowhere else.
 *
 * WHAT COVERS THE REST. Tree equality holds exactly while the base has not moved
 * since the branch point, so this covers a quiet repository and abandons a busy
 * one: a merge that raced another landing carries nothing. `push` on the default
 * branch (`default-branch-baseline.ts`) is what covers every merge strategy and
 * every race, by measuring the commit wherever it came from. This stays because
 * it is nearly free where it applies: the set already exists and the copy is two
 * commit reads, against a capture the other path has to pay for.
 *
 * AND BECAUSE IT IS THE BETTER BASELINE WHERE BOTH APPLY (added August 19,
 * 2026). The two paths do not render the same thing. This one carries a set
 * measured at the merged pull request's own PREVIEW; the push path measures
 * whatever `preview.default_branch_url` names, which for most teams is
 * production. The next pull request is measured at a preview too, so the carried
 * set compares like against like, and the pushed one compares production against
 * a preview and turns seed data, feature flags, a signed-out state or a consent
 * banner into a violation that pull request appears to have introduced. So on a
 * merge that fires both, this one now wins, which reverses the rule of the day
 * before. The argument is written out where the code decides it, below.
 *
 * THE DISCIPLINE, WHICH IS THE WHOLE DESIGN. A set is copied ONLY when the merge
 * commit's tree sha is identical to the tree sha of the head that was reviewed.
 * Equal trees are byte-identical content, so the stored measurements describe the
 * merge commit exactly and copying them states a fact. Unequal trees mean the
 * merge produced content nobody rendered (a squash onto a base that moved, a
 * merge commit combining two branches), and copying there would publish a
 * measurement result that no capture, no check and no engine ever produced,
 * against which a later pull request would then be gated. That is the one defect
 * this codebase exists to avoid, so an unequal tree records NOTHING and says why.
 *
 * Nothing here is re-derived. The carried set keeps the identity version and the
 * engine version it was computed under, so a later comparison refuses it for
 * version skew on exactly the same terms it would refuse the original.
 *
 * It runs after delivery and is best-effort in every direction: it never
 * publishes, never fails a review, and never throws at its caller.
 *
 * NO NEW PERMISSION. The tree comparison reads
 * `GET /repos/{owner}/{repo}/git/commits/{sha}`, which the App's existing
 * `contents: read` already covers. Nothing here needs `contents: write`, and
 * nothing here writes to the customer's repository.
 */

/** The commit-tree lookup, installation-authed like `resolvePullRequest`. */
export interface MergeCommitTreeReader {
  /** The commit's tree sha, or null when Gate could not read the commit. */
  getCommitTreeSha(
    owner: string,
    name: string,
    sha: string,
    installationId: number,
  ): Promise<string | null>;
}

export interface BaselineCarryForwardDeps {
  /**
   * The durable per-commit measurement sets. Absent means this deployment stores
   * no baselines at all, so there is nothing to carry and nothing to carry it
   * onto; the Action path is permanently in that state.
   */
  measurementBaselines?: MeasurementBaselineStore;
  /** Reads commit trees; absent disables the carry-forward rather than skipping the check. */
  commits?: MergeCommitTreeReader;
  now?: () => number;
}

/** Why a merge produced no carried baseline, or that it produced one. */
export type BaselineCarryOutcome =
  /** The set was copied: `from` was measured, `to` has the identical tree. */
  | { status: "carried"; from: string; to: string; treeSha: string }
  /** Not a merged `pull_request` `closed` event, or not a `pull_request` at all. */
  | { status: "not_merged" }
  /** Merged, but this deployment or this payload cannot carry anything forward. */
  | { status: "skipped"; reason: CarrySkipReason }
  /** Gate never measured the head this pull request merged. */
  | { status: "no_baseline"; headSha: string }
  /** A commit could not be read, so the trees were never compared. */
  | { status: "unreadable_commit"; headSha: string; mergeSha: string }
  /** The merge produced a tree nobody measured. Recording anything would be a fiction. */
  | { status: "tree_changed"; headSha: string; mergeSha: string }
  /**
   * A set was already stored for the merge commit, and it is not one this copy
   * improves on: it was already measured at a pull request's preview, which is
   * the property that makes a copy worth preferring in the first place.
   */
  | { status: "already_recorded"; mergeSha: string }
  /** The store or the GitHub read threw. Logged, never raised. */
  | { status: "failed"; detail: string };

export type CarrySkipReason =
  /** No baseline store and/or no commit reader is bound on this path. */
  | "not_configured"
  /** The payload is missing the repository, installation, head or merge commit. */
  | "incomplete_event"
  /** GitHub reported the merge commit as the head commit; there is nothing to copy onto. */
  | "merge_is_head";

interface MergedPullRequestEvent {
  installationId: number;
  owner: string;
  name: string;
  prNumber: number;
  headSha: string;
  mergeSha: string;
}

interface RawMergeEnvelope {
  action?: unknown;
  installation?: { id?: unknown };
  repository?: { name?: unknown; owner?: { login?: unknown } };
  pull_request?: {
    number?: unknown;
    merged?: unknown;
    merge_commit_sha?: unknown;
    head?: { sha?: unknown };
  };
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

type ParsedMerge =
  | { kind: "not_merged" }
  | { kind: "incomplete" }
  | { kind: "merged"; event: MergedPullRequestEvent };

/**
 * The merged-pull-request facts, or why there are none.
 *
 * `action: "closed"` and `merged: true` are two separate conditions on purpose.
 * A pull request closed WITHOUT merging put no commit on the base branch, so
 * there is no commit to carry a set onto and the head that was reviewed
 * describes nothing that shipped. GitHub still sends a `merge_commit_sha` on
 * such a payload, left over from a mergeability probe, and it names a commit
 * that is on no branch; reading the sha without reading `merged` would file a
 * measurement set under it and hand it to the next pull request as a baseline.
 */
function parseMergedPullRequest(payload: unknown): ParsedMerge {
  const event = payload as RawMergeEnvelope | null;
  if (!event || typeof event !== "object") return { kind: "not_merged" };
  if (event.action !== "closed") return { kind: "not_merged" };
  if (event.pull_request?.merged !== true) return { kind: "not_merged" };

  const installationId = event.installation?.id;
  const owner = str(event.repository?.owner?.login);
  const name = str(event.repository?.name);
  const prNumber = event.pull_request?.number;
  const headSha = str(event.pull_request?.head?.sha);
  const mergeSha = str(event.pull_request?.merge_commit_sha);
  if (
    typeof installationId !== "number" ||
    !owner ||
    !name ||
    typeof prNumber !== "number" ||
    !headSha ||
    !mergeSha
  ) {
    return { kind: "incomplete" };
  }
  return { kind: "merged", event: { installationId, owner, name, prNumber, headSha, mergeSha } };
}

/**
 * Copy the stored set from a merged pull request's head onto its merge commit,
 * when and only when the two commits have the same tree.
 *
 * Returns what happened so a caller can assert on it; the outcome is also
 * logged, because the interesting cases are the ones that record nothing and a
 * fleet that silently never carries anything forward looks exactly like one that
 * has nothing to carry.
 */
export async function carryBaselineOnMerge(
  payload: unknown,
  deps: BaselineCarryForwardDeps,
): Promise<BaselineCarryOutcome> {
  const parsed = parseMergedPullRequest(payload);
  if (parsed.kind === "not_merged") return { status: "not_merged" };

  const store = deps.measurementBaselines;
  const commits = deps.commits;
  if (!store || !commits) return { status: "skipped", reason: "not_configured" };
  if (parsed.kind === "incomplete") {
    console.error("[gate] baseline carry-forward skipped: merged pull_request payload is incomplete");
    return { status: "skipped", reason: "incomplete_event" };
  }
  const { installationId, owner, name, headSha, mergeSha } = parsed.event;
  const repo = `${owner}/${name}`;
  if (mergeSha === headSha) {
    // Nothing to copy onto, and copying onto itself would rewrite an OBSERVED
    // row as a carried one, losing the only record of which commit was rendered.
    console.log(`[gate] baseline carry-forward skipped for ${repo}: merge commit is the reviewed head`);
    return { status: "skipped", reason: "merge_is_head" };
  }

  try {
    const stored = await store.find({ installationId: String(installationId), owner, name, commitSha: headSha });
    if (!stored) {
      // Nothing was ever measured for this head: the review never completed, the
      // preview never came up, or the set was recorded before this repository
      // had a store. Nothing to carry, and inventing one is not an option.
      console.log(
        `[gate] baseline carry-forward skipped for ${repo}: no measurement set stored for head ${headSha}`,
      );
      return { status: "no_baseline", headSha };
    }

    const [headTree, mergeTree] = await Promise.all([
      commits.getCommitTreeSha(owner, name, headSha, installationId),
      commits.getCommitTreeSha(owner, name, mergeSha, installationId),
    ]);
    if (headTree === null || mergeTree === null) {
      // "I could not look" is not "they matched". A missing answer must never
      // become a copy, because the copy is only true if the trees are equal.
      console.error(
        `[gate] baseline carry-forward skipped for ${repo}: could not read the tree of ${headTree === null ? headSha : mergeSha}`,
      );
      return { status: "unreadable_commit", headSha, mergeSha };
    }
    if (headTree !== mergeTree) {
      // The merge produced content nobody rendered. Recording the head's
      // measurements against it would assert a result nothing produced, and the
      // next pull request would be gated on that assertion.
      console.log(
        `[gate] baseline carry-forward declined for ${repo}: merge commit ${mergeSha} (tree ${mergeTree}) ` +
          `differs from reviewed head ${headSha} (tree ${headTree}); ` +
          `no measurement set describes ${mergeSha}, so none was recorded`,
      );
      return { status: "tree_changed", headSha, mergeSha };
    }

    // THE PREVIEW-MEASURED SET OUTRANKS THE OTHER ONE, WHICHEVER ARRIVES FIRST,
    // and this reverses what this code said on August 18, 2026.
    //
    // A merge whose tree matched fires both mechanisms on the same commit: this
    // copy, and the default-branch push that captures the commit at
    // `preview.default_branch_url`. The store upserts on (repository, commit),
    // so something has to rank them, and the old rule ranked them by directness:
    // "an observed measurement outranks a copy". That is the right instinct
    // about evidence and the wrong question. BOTH are observed. Tree equality is
    // what allowed this copy, and equal trees are byte-identical content, so the
    // carried set is a real capture of exactly this commit's content; the only
    // thing deduced about it is which commit to file it under.
    //
    // What separates them is WHERE they were rendered, and a baseline is not an
    // archive of the branch. Its whole job is to be the left-hand side of a
    // comparison whose right-hand side is the next pull request, measured at
    // that pull request's own preview. The carried set was measured at a preview
    // too, so it compares like against like. The pushed set was measured at the
    // default branch's deployment, which for most teams is production, and every
    // difference between production and a preview that is not the pull request's
    // doing then reads as a violation the pull request introduced. Ranking by
    // comparability rather than by directness is what makes the next comparison
    // answerable at all.
    //
    // ORDER-INDEPENDENCE IS PRESERVED, which is what the old rule was really
    // protecting. This copy REPLACES a default-branch set that landed first, and
    // the push path declines to overwrite a preview-measured set that landed
    // first (`default-branch-baseline.ts`). Both directions end at the same
    // stored row, so the two webhooks may finish in either order.
    const existing = await store.find({
      installationId: String(installationId),
      owner,
      name,
      commitSha: mergeSha,
    });
    const snapshot = carryMeasurementBaselineForward(stored, {
      commitSha: mergeSha,
      recordedAtMs: (deps.now ?? Date.now)(),
    });
    if (existing && !baselineSupersedes(snapshot, existing)) {
      console.log(
        `[gate] baseline carry-forward skipped for ${repo}: ${mergeSha} already has a measurement set ` +
          "this copy does not improve on",
      );
      return { status: "already_recorded", mergeSha };
    }

    await store.record({
      installationId: String(installationId),
      owner,
      name,
      commitSha: mergeSha,
      snapshot,
    });
    console.log(
      `[gate] baseline carried forward for ${repo}: ${headSha} -> ${mergeSha} (identical tree ${headTree})`,
    );
    return { status: "carried", from: headSha, to: mergeSha, treeSha: headTree };
  } catch (err) {
    // Exactly like the record call this mirrors: logged, never raised. This runs
    // after the review was delivered, so a store outage here costs the NEXT pull
    // request its scoping and costs this one nothing.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[gate] baseline carry-forward failed for ${repo}: ${detail}`);
    return { status: "failed", detail };
  }
}
