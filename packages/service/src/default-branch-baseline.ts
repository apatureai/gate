import { DEFAULT_CONFIG } from "@gate/config";
import { buildMeasurementBaseline, type MeasurementBaselineStore } from "@gate/delivery";
import { type MeasurementProbe, verifyPreviewHandoff } from "@gate/engine";
import type { GateMeasurementRequest, NormalizedDesignReviewConfig } from "@gate/types";

/**
 * Record a measurement baseline for a commit that landed on the default branch.
 *
 * WHY THIS EXISTS, AND WHY THE MERGE CARRY-FORWARD WAS NOT ENOUGH.
 * `rules.measurements: block` scopes a pull request against the set stored for
 * its BASE commit. Sets are recorded for a reviewed pull request head, and are
 * carried onto a merge commit when its tree is provably the tree that was
 * measured. Tree equality holds exactly when the base has not moved since the
 * branch point, so the carry-forward covers a quiet repository and abandons a
 * busy one: any merge that races another landing carries nothing, the next pull
 * request against that branch reads `no baseline`, and the gate goes silent on
 * precisely the merges that followed a race. Watching the default branch itself
 * is the only mechanism that covers every merge strategy and every race, because
 * every one of them ends in a commit on that branch.
 *
 * WHAT MAKES IT AFFORDABLE, WHICH IS THE WHOLE REASON IT IS WORTH DOING. A
 * baseline needs MEASUREMENTS ONLY. The stored set is deterministic capture
 * output (contrast, overflow, touch target) plus the routes and viewports that
 * were measured. None of it is a judgment, so none of it needs a model. This
 * path therefore captures, measures, and stops: it calls the measure-only seam
 * (`MeasurementProbe`), never `JudgmentEngineClient`, and there is no engine
 * client in its dependencies to call by accident.
 *
 * NOTHING A PUSH PRODUCES MAY RENDER AS A REVIEW. No Check Run, no comment, no
 * run row, no grade. The deps below carry no `publishCheckRun`, no
 * `GitHubCommentsApi` and no `RunStore`, so the delivery side is not merely
 * unused here, it is unreachable from here. A push is not a review, and the only
 * thing it leaves behind is a row in `measurement_baselines`.
 *
 * NO NEW PERMISSION. `push` is an event subscription, not a permission. The
 * repository, its default branch, the pushed commit and the installation all
 * arrive in the webhook payload; the configuration read is the same
 * `contents: read` load a review already does. Nothing here writes to the
 * customer's repository.
 */

/** The repository and commit a push wants a baseline for. */
export interface DefaultBranchTarget {
  installationId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  commitSha: string;
}

export interface DefaultBranchBaselineDeps {
  /**
   * The durable per-commit measurement sets. Absent means this deployment stores
   * no baselines at all, so there is nothing to record one into; the Action path
   * is permanently in that state.
   */
  measurementBaselines?: MeasurementBaselineStore;
  /**
   * Capture-and-measure, with no model call. Absent disables the whole path
   * rather than falling back to a review: there is no cheaper way to obtain a
   * measurement than measuring, and there is no acceptable way to obtain one
   * that bills a model call on every push.
   */
  measure?: MeasurementProbe;
  /**
   * The repository's `.gate.yml` at the pushed commit. Defaults to
   * `DEFAULT_CONFIG`, whose `preview.defaultBranchUrl` is null, so a deployment
   * that binds no loader records nothing and says so.
   */
  loadConfig?(target: DefaultBranchTarget): Promise<NormalizedDesignReviewConfig>;
  now?: () => number;
}

/** Why a push recorded no baseline, or that it recorded one. */
export type DefaultBranchBaselineOutcome =
  /** A set was measured and stored for `commitSha`. */
  | { status: "recorded"; commitSha: string; checksRun: number; entries: number }
  /** Not a push to the default branch: another branch, a tag, or not a push at all. */
  | { status: "not_default_branch"; ref?: string }
  /** The ref was deleted, so there is no commit on it to measure. */
  | { status: "branch_deleted"; ref: string }
  /** This deployment or this payload cannot record anything. */
  | { status: "skipped"; reason: PushSkipReason }
  /** A URL Gate will not hand to a capture, with the reason it refused. */
  | { status: "unverified_url"; reason: string }
  /** The config read, the measure call or the store threw. Logged, never raised. */
  | { status: "failed"; detail: string };

export type PushSkipReason =
  /** No baseline store and/or no measure probe is bound on this path. */
  | "not_configured"
  /** The payload is missing the repository, installation, ref, default branch or commit. */
  | "incomplete_event"
  /** The repository has not said where its default branch is deployed. */
  | "no_default_branch_url";

interface RawPushEnvelope {
  ref?: unknown;
  after?: unknown;
  deleted?: unknown;
  installation?: { id?: unknown };
  repository?: { name?: unknown; owner?: { login?: unknown }; default_branch?: unknown };
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** GitHub's "there is no commit here" sha, sent on a deletion. */
const ZERO_SHA = "0".repeat(40);

type ParsedPush =
  | { kind: "not_default_branch"; ref?: string }
  | { kind: "branch_deleted"; ref: string }
  | { kind: "incomplete" }
  | { kind: "push"; target: DefaultBranchTarget };

/**
 * The default-branch-push facts, or why there are none.
 *
 * THE DEFAULT BRANCH IS READ FROM THE PAYLOAD, never assumed to be `main`. A
 * repository whose default branch is `master`, `trunk` or `develop` is not an
 * edge case, and hard-coding a name would leave those repositories with the
 * silent gate this whole path exists to close while looking, from the outside,
 * exactly like one that was working.
 *
 * A TAG PUSH AND A BRANCH PUSH ARRIVE ON THE SAME EVENT. `refs/tags/v1.4.0` is a
 * `push` delivery like any other, and tagging a release tags a commit that is
 * usually ON the default branch, so a handler that looked only at the commit
 * would file a second baseline for it every time someone cut a release. The ref
 * comparison is against `refs/heads/<default>` exactly, so a tag matches nothing.
 *
 * A DELETION CARRIES A REAL REF AND NO COMMIT. GitHub sends `deleted: true` with
 * `after` set to forty zeros. Reading the sha without reading either would file a
 * measurement set under a commit that does not exist and hand it to the next
 * pull request as a baseline.
 *
 * A FORCE PUSH IS TREATED AS AN ORDINARY PUSH, deliberately. A stored set is a
 * statement about a COMMIT, not about a branch: "this tree, measured, produced
 * these violations". Rewriting the branch does not make that statement false
 * about the commit it names, so nothing already stored is invalidated, and the
 * commit the force push landed is measured on its own terms like any other. The
 * orphaned sets stay addressable, cost one row each, and are still correct for
 * any pull request whose base is one of them.
 *
 * A MERGE QUEUE NEEDS NO SPECIAL CASE, for the same reason. Its staging refs are
 * `refs/heads/gh-readonly-queue/<branch>/...`, which are not the default branch,
 * so they record nothing; when the queue lands the batch, that landing is a push
 * to the default branch and is measured there. Measuring the staging refs would
 * spend a capture per attempt on commits most of which are discarded.
 */
export function parseDefaultBranchPush(payload: unknown): ParsedPush {
  const event = payload as RawPushEnvelope | null;
  if (!event || typeof event !== "object") return { kind: "not_default_branch" };
  const ref = str(event.ref);
  const defaultBranch = str(event.repository?.default_branch);
  if (!ref || !defaultBranch) return { kind: "not_default_branch", ...(ref ? { ref } : {}) };
  if (ref !== `refs/heads/${defaultBranch}`) return { kind: "not_default_branch", ref };
  if (event.deleted === true) return { kind: "branch_deleted", ref };

  const installationId = event.installation?.id;
  const owner = str(event.repository?.owner?.login);
  const name = str(event.repository?.name);
  const after = str(event.after);
  if (typeof installationId !== "number" || !owner || !name || !after) {
    return { kind: "incomplete" };
  }
  // A zero `after` is a deletion whatever `deleted` said. Both are checked
  // because either one alone is a single field standing between a nonexistent
  // commit and the baseline store.
  if (after === ZERO_SHA) return { kind: "branch_deleted", ref };
  return {
    kind: "push",
    target: {
      installationId: String(installationId),
      owner,
      name,
      defaultBranch,
      commitSha: after,
    },
  };
}

/** Substitute the pushed commit into a configured default-branch URL. */
export function fillDefaultBranchUrl(template: string, commitSha: string): string {
  return template.replaceAll("{sha}", commitSha).replaceAll("{short_sha}", commitSha.slice(0, 7));
}

/**
 * Capture and measure the commit a push put on the default branch, and store the
 * result as that commit's measurement baseline.
 *
 * Returns what happened so a caller can assert on it; the outcome is also
 * logged, because the interesting cases are the ones that record nothing, and a
 * fleet that silently never records anything looks exactly like one with nothing
 * to record.
 *
 * IT NEVER THROWS AND IT NEVER RETRIES. A push that fails costs the next pull
 * request its scoping and costs this push nothing, which is the whole risk
 * budget this path is allowed. Retrying inside the handler would turn one bad
 * minute on a busy default branch into a stampede of captures against an engine
 * that is already failing, and nobody is waiting on the answer.
 */
export async function recordDefaultBranchBaseline(
  payload: unknown,
  deps: DefaultBranchBaselineDeps,
): Promise<DefaultBranchBaselineOutcome> {
  const parsed = parseDefaultBranchPush(payload);
  if (parsed.kind === "not_default_branch") {
    return { status: "not_default_branch", ...(parsed.ref ? { ref: parsed.ref } : {}) };
  }
  if (parsed.kind === "branch_deleted") {
    console.log(`[gate] default-branch baseline skipped: ${parsed.ref} was deleted, so no commit was measured`);
    return { status: "branch_deleted", ref: parsed.ref };
  }

  const store = deps.measurementBaselines;
  const probe = deps.measure;
  if (!store || !probe) return { status: "skipped", reason: "not_configured" };
  if (parsed.kind === "incomplete") {
    console.error("[gate] default-branch baseline skipped: push payload is incomplete");
    return { status: "skipped", reason: "incomplete_event" };
  }

  const target = parsed.target;
  const repo = `${target.owner}/${target.name}`;
  try {
    const config = (await deps.loadConfig?.(target)) ?? DEFAULT_CONFIG;
    const template = config.preview.defaultBranchUrl;
    if (!template) {
      // Not an error and not a failure: the repository has not said where its
      // default branch is deployed, and Gate will not guess an address to point
      // a browser at. Logged once per push so an operator who expected a
      // baseline can see the reason rather than an absence.
      console.log(
        `[gate] default-branch baseline skipped for ${repo}: preview.default_branch_url is not set, ` +
          `so nothing names the deployment of ${target.defaultBranch}`,
      );
      return { status: "skipped", reason: "no_default_branch_url" };
    }

    // The same provenance guard a review's preview goes through. The URL is an
    // operator-supplied literal from the repository's own configuration, which is
    // exactly what the `explicit` source means, and it is re-verified here rather
    // than trusted because it reached this process as repository content.
    const verified = verifyPreviewHandoff({
      url: fillDefaultBranchUrl(template, target.commitSha),
      source: "explicit",
      provider: "explicit",
      // The default branch is the repository's own, never a fork's.
      isFork: false,
      protectionBypassSecretName: config.preview.protectionBypassSecretName,
      authStateSecretName: config.preview.authStateSecretName,
    });
    if (!verified.ok) {
      console.error(`[gate] default-branch baseline refused for ${repo}: ${verified.reason}`);
      return { status: "unverified_url", reason: verified.reason };
    }

    const request: GateMeasurementRequest = {
      installationId: target.installationId,
      repository: {
        owner: target.owner,
        name: target.name,
        defaultBranch: target.defaultBranch,
      },
      commitSha: target.commitSha,
      preview: {
        url: verified.url,
        provider: verified.provider,
        environment: config.preview.environment,
      },
      config: {
        ...config,
        preview: {
          ...config.preview,
          protectionBypassSecretName: verified.protectionBypassSecretName,
          authStateSecretName: verified.authStateSecretName,
        },
      },
    };

    const measured = await probe.measure(request);
    const snapshot = buildMeasurementBaseline(measured, {
      commitSha: target.commitSha,
      recordedAtMs: (deps.now ?? Date.now)(),
    });
    await store.record({
      installationId: target.installationId,
      owner: target.owner,
      name: target.name,
      commitSha: target.commitSha,
      snapshot,
    });
    console.log(
      `[gate] default-branch baseline recorded for ${repo} at ${target.commitSha}: ` +
        `${snapshot.checksRun.length} check(s) over ${snapshot.routesMeasured.length} route(s), ` +
        `${snapshot.entries.length} violation(s). No review was published and no model was called.`,
    );
    return {
      status: "recorded",
      commitSha: target.commitSha,
      checksRun: snapshot.checksRun.length,
      entries: snapshot.entries.length,
    };
  } catch (err) {
    // Logged, never raised, never retried, never surfaced to a user. There is no
    // pull request here and no Check Run to turn red: the only consequence of
    // this failure is that the next pull request based on this commit reads
    // `no baseline`, which is the same safe direction every other missing
    // baseline takes.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[gate] default-branch baseline failed for ${repo}: ${detail}`);
    return { status: "failed", detail };
  }
}
