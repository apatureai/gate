import {
  type DefaultBranchBaselineDeps,
  type DefaultBranchBaselineOutcome,
  measureDefaultBranchBaseline,
} from "./default-branch-baseline.js";
import type { DefaultBranchHead } from "./github-repository.js";

/**
 * Scope a repository the moment the App is installed on it.
 *
 * THE PROBLEM THIS CLOSES. A default branch acquires baselines from the first
 * push AFTER the App arrives, so a team that installs Gate, sets
 * `rules.measurements: block` and opens a pull request that same afternoon gets
 * a check that classifies nothing and fails nothing. It is green because nobody
 * looked, it looks exactly like a check that passed, and it stays that way until
 * somebody merges. That is the worst possible first impression for the feature
 * the project leads with, and the fix is to measure the default branch once,
 * when the App is installed, so the very next pull request has a base.
 *
 * IT IS THE SAME PATH A PUSH TAKES. `measureDefaultBranchBaseline` is called
 * directly, not re-implemented: measurements only, no model call, no grade, no
 * Check Run, no comment, no run row, nothing published. An installation is not a
 * review and nothing it produces may render as one. The deps below carry no
 * engine client, no comments API, no Check Run publisher and no run store, so
 * the delivery side is not merely unused here, it is unreachable from here.
 *
 * WHAT THE EVENT DOES NOT TELL US. A push payload names the commit; an
 * installation payload names repositories and nothing else, so the default
 * branch and its tip are read back through `readDefaultBranchHead`
 * (Metadata + `contents: read`, both already held). NO PERMISSION IS WIDENED for
 * this, and `installation` / `installation_repositories` are event
 * subscriptions rather than permissions. If this had needed a scope the App does
 * not hold, the correct response would have been to stop.
 *
 * AN INSTALLATION CAN ADD HUNDREDS OF REPOSITORIES AT ONCE. Installing on an
 * organisation with "All repositories" selected delivers one event listing every
 * one of them, and each repository here costs a full browser capture in the
 * critique service. Firing them together would be a self-inflicted denial of
 * service against the same capture pool that is serving pull request reviews
 * somebody IS waiting on. So the list is walked at a fixed small width
 * (`INSTALLATION_BASELINE_CONCURRENCY`) and NOTHING IS DROPPED: a 300-repository
 * installation is still 300 captures, two at a time, finishing over the
 * following hours behind the webhook response. Repositories measured later are
 * scoped later, which is strictly better than the nothing they had before, and
 * far better than a stampede that would delay every review in the fleet.
 */

/** How many repositories an installation may measure at once. */
export const INSTALLATION_BASELINE_CONCURRENCY = 2;

/** The two deliveries that mean "Gate can now see this repository". */
export type InstallationEventName = "installation" | "installation_repositories";

/** A repository named by an installation delivery. */
export interface InstallationRepository {
  owner: string;
  name: string;
}

export interface InstallationBaselineDeps extends DefaultBranchBaselineDeps {
  /**
   * The repository's default branch and its tip commit. Absent disables the
   * whole path: there is no other way to learn which commit to measure, and
   * guessing `main` would file a set under a commit nobody looked at.
   */
  readDefaultBranchHead?(repo: {
    installationId: string;
    owner: string;
    name: string;
  }): Promise<DefaultBranchHead | null>;
  /** Repositories measured at once. Defaults to `INSTALLATION_BASELINE_CONCURRENCY`. */
  installationConcurrency?: number;
}

/** What one repository in the installation ended up with. */
export interface RepositoryBaselineResult {
  /** `owner/name`. */
  repository: string;
  outcome:
    | DefaultBranchBaselineOutcome
    /** The default branch or its tip could not be read, so there was no commit to measure. */
    | { status: "unreadable_repository"; detail?: string };
}

export type InstallationSkipReason =
  /** No baseline store, no measure probe and/or no repository reader is bound. */
  | "not_configured"
  /** The payload is missing the installation id, or every repository entry was unusable. */
  | "incomplete_event"
  /** The delivery named no repositories at all. */
  | "no_repositories";

export type InstallationBaselineOutcome =
  /** Every named repository was walked; `results` says what each one produced. */
  | {
      status: "scoped";
      installationId: string;
      repositories: number;
      recorded: number;
      results: RepositoryBaselineResult[];
    }
  /** Not an install or an add: a removal, a deletion, a suspension, a permissions bump. */
  | { status: "ignored"; event: InstallationEventName; action?: string }
  /** This deployment or this payload cannot record anything. */
  | { status: "skipped"; reason: InstallationSkipReason };

type ParsedInstallation =
  | { kind: "scope"; installationId: string; repositories: InstallationRepository[] }
  | { kind: "ignored"; action?: string }
  | { kind: "incomplete" }
  | { kind: "no_repositories" };

interface RawInstallationEnvelope {
  action?: unknown;
  installation?: { id?: unknown; account?: { login?: unknown } };
  repositories?: unknown;
  repositories_added?: unknown;
  repositories_removed?: unknown;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The repository the App was just given, or nothing.
 *
 * `full_name` is preferred because it carries the owner and the name as one
 * authoritative pair. `installation.account.login` is the fallback, and it is
 * sound because an installation belongs to exactly one account and every
 * repository in it is owned by that account. A repository entry with neither is
 * SKIPPED rather than guessed at: a wrong owner would send the capture at
 * somebody else's deployment.
 */
function parseRepository(raw: unknown, accountLogin?: string): InstallationRepository | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as { name?: unknown; full_name?: unknown };
  const fullName = str(entry.full_name);
  if (fullName) {
    const slash = fullName.indexOf("/");
    if (slash > 0 && slash < fullName.length - 1) {
      return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
    }
  }
  const name = str(entry.name);
  if (name && accountLogin) return { owner: accountLogin, name };
  return null;
}

/**
 * Which repositories a delivery hands Gate, or why none.
 *
 * THE ACTION IS CHECKED BEFORE THE REPOSITORY LIST, AND THE LIST IS READ FROM
 * EXACTLY ONE FIELD PER EVENT. Both matter, and both are the same mistake in two
 * shapes. `installation` carries `repositories`; `installation_repositories`
 * carries `repositories_added` AND, on the very same delivery, sometimes
 * `repositories_removed`. A parser that fell back across those fields would
 * measure a repository on the delivery that says the App was just REMOVED from
 * it, which is a capture against a deployment Gate has no business touching and
 * a row filed for a tenant that just left.
 *
 * `installation` has actions beyond `created`: `deleted`, `suspend`, `unsuspend`
 * and `new_permissions_accepted`, and `deleted` carries the full repository list
 * exactly like `created` does. Only `created` and `added` scope anything.
 */
export function parseInstallationScope(
  event: InstallationEventName,
  payload: unknown,
): ParsedInstallation {
  const envelope = payload as RawInstallationEnvelope | null;
  if (!envelope || typeof envelope !== "object") return { kind: "incomplete" };
  const action = str(envelope.action);

  const wanted = event === "installation" ? "created" : "added";
  if (action !== wanted) return { kind: "ignored", ...(action ? { action } : {}) };

  const installationId = envelope.installation?.id;
  if (typeof installationId !== "number") return { kind: "incomplete" };

  const list = event === "installation" ? envelope.repositories : envelope.repositories_added;
  if (!Array.isArray(list) || list.length === 0) return { kind: "no_repositories" };

  const accountLogin = str(envelope.installation?.account?.login);
  const repositories: InstallationRepository[] = [];
  for (const raw of list) {
    const repo = parseRepository(raw, accountLogin);
    if (repo) repositories.push(repo);
  }
  if (repositories.length === 0) return { kind: "incomplete" };
  return { kind: "scope", installationId: String(installationId), repositories };
}

/**
 * Walk `items` at most `limit` at a time, in order, collecting one result each.
 *
 * `run` is called inside the caller's own try/catch, so a repository that fails
 * cannot stop the ones behind it: a single rejection escaping here would leave
 * the other workers running detached and the remaining repositories unscoped.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // A ceiling, not a target: a width above `items.length` just leaves workers
  // with nothing to take. A width below one would start no workers at all and
  // scope the whole installation silently, which is what the floor is for.
  const width = Math.max(1, limit);
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

/**
 * Record a measurement baseline for the default branch of every repository an
 * installation just gave Gate.
 *
 * Returns what happened so a caller can assert on it; every branch is also
 * logged, because the interesting cases are the ones that record nothing and a
 * fleet that silently scopes nothing looks exactly like one with nothing to
 * scope.
 *
 * IT NEVER THROWS, IT NEVER RETRIES, AND NOTHING SURFACES TO A USER. There is no
 * pull request here and no Check Run to turn red. A repository whose measure
 * fails is left exactly where it was before this feature existed: its next pull
 * request reads `no baseline`, which is the same safe direction every other
 * missing baseline takes.
 */
export async function recordInstallationBaselines(
  event: InstallationEventName,
  payload: unknown,
  deps: InstallationBaselineDeps,
): Promise<InstallationBaselineOutcome> {
  const parsed = parseInstallationScope(event, payload);
  if (parsed.kind === "ignored") {
    return { status: "ignored", event, ...(parsed.action ? { action: parsed.action } : {}) };
  }
  if (!deps.measurementBaselines || !deps.measure || !deps.readDefaultBranchHead) {
    return { status: "skipped", reason: "not_configured" };
  }
  if (parsed.kind === "incomplete") {
    console.error(`[gate] installation baseline skipped: ${event} payload is incomplete`);
    return { status: "skipped", reason: "incomplete_event" };
  }
  if (parsed.kind === "no_repositories") {
    console.log(`[gate] installation baseline skipped: ${event} named no repositories`);
    return { status: "skipped", reason: "no_repositories" };
  }

  const readHead = deps.readDefaultBranchHead;
  const { installationId, repositories } = parsed;
  const width = deps.installationConcurrency ?? INSTALLATION_BASELINE_CONCURRENCY;
  console.log(
    `[gate] installation ${installationId}: scoping ${repositories.length} repositor` +
      `${repositories.length === 1 ? "y" : "ies"} at most ${width} at a time. ` +
      `Measurements only: no model is called and nothing is published.`,
  );

  const results = await mapBounded(repositories, width, async (repo) => {
    const name = `${repo.owner}/${repo.name}`;
    try {
      const head = await readHead({ installationId, owner: repo.owner, name: repo.name });
      if (!head) {
        console.log(
          `[gate] installation baseline skipped for ${name}: its default branch or that branch's ` +
            `tip commit could not be read, so there is no commit to measure`,
        );
        return { repository: name, outcome: { status: "unreadable_repository" as const } };
      }
      // The same path a push takes, called rather than copied.
      const outcome = await measureDefaultBranchBaseline(
        {
          installationId,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: head.defaultBranch,
          commitSha: head.commitSha,
        },
        deps,
      );
      return { repository: name, outcome };
    } catch (err) {
      // One repository's failure must not cost the rest of the installation
      // their scoping. `measureDefaultBranchBaseline` resolves its own failures
      // into an outcome, so this catches the read above and is the belt to that
      // braces for any future edit that made either throw.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[gate] installation baseline failed for ${name}: ${detail}`);
      return { repository: name, outcome: { status: "unreadable_repository" as const, detail } };
    }
  });

  const recorded = results.filter((r) => r.outcome.status === "recorded").length;
  console.log(
    `[gate] installation ${installationId}: scoped ${results.length} repositories, ` +
      `${recorded} baseline(s) recorded. No review was published and no model was called.`,
  );
  return {
    status: "scoped",
    installationId,
    repositories: repositories.length,
    recorded,
    results,
  };
}
