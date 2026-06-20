import { tokenBucketKey } from "@gate/redis";

/**
 * Concurrency + fair scheduling (TRD §3.2, §15.2). `(repo, pr) = 1` is enforced
 * structurally by the queue jobId (`repo#pr`); on top of that, per-installation
 * concurrency is capped tier-based and the scheduler round-robins across
 * installations so one hot PR/installation can't starve a busy monorepo. The
 * per-installation token-bucket is bespoke; the migration path is Inngest native
 * `concurrency: [{ scope: "account", limit: tier }]` (#48/#54).
 */
export type Tier = "free" | "team" | "business" | "enterprise";

export const TIER_CONCURRENCY: Record<Tier, number> = {
  free: 1,
  team: 3,
  business: 5,
  enterprise: 10,
};

export function tierConcurrency(tier: Tier): number {
  return TIER_CONCURRENCY[tier];
}

export interface PendingJob {
  installationId: string;
  /** Supersession/dedup key, `repo#pr`. */
  key: string;
}

export interface SelectOptions {
  perInstallationCap: number;
  /** Jobs already running per installation. */
  inFlightByInstallation?: Record<string, number>;
  /** `(repo, pr)` keys already running — never start a second one. */
  inFlightKeys?: Iterable<string>;
  /** Global slots available to start now. */
  maxToStart: number;
}

/**
 * Pick the next jobs to start: round-robin one per installation per pass (fair),
 * respecting the per-installation cap and `(repo, pr) = 1`. Returns jobs in the
 * fair start order.
 */
export function selectNextJobs(pending: PendingJob[], options: SelectOptions): PendingJob[] {
  const inFlight = options.inFlightByInstallation ?? {}; // read-only; selected counts tracked separately
  const runningKeys = new Set(options.inFlightKeys ?? []);
  const selected: PendingJob[] = [];
  const selectedKeys = new Set<string>();
  const selectedPerInstallation = new Map<string, number>();

  const byInstallation = new Map<string, PendingJob[]>();
  for (const job of pending) {
    const list = byInstallation.get(job.installationId) ?? [];
    list.push(job);
    byInstallation.set(job.installationId, list);
  }
  const installations = [...byInstallation.keys()];

  let progressed = true;
  while (selected.length < options.maxToStart && progressed) {
    progressed = false;
    for (const installation of installations) {
      if (selected.length >= options.maxToStart) break;
      const used = (inFlight[installation] ?? 0) + (selectedPerInstallation.get(installation) ?? 0);
      if (used >= options.perInstallationCap) continue;

      const list = byInstallation.get(installation)!;
      const idx = list.findIndex((j) => !selectedKeys.has(j.key) && !runningKeys.has(j.key));
      if (idx === -1) continue;

      const [job] = list.splice(idx, 1);
      selected.push(job!);
      selectedKeys.add(job!.key);
      selectedPerInstallation.set(installation, (selectedPerInstallation.get(installation) ?? 0) + 1);
      progressed = true;
    }
  }
  return selected;
}

export interface CounterStore {
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  get(key: string): Promise<number>;
}

export function createInMemoryCounterStore(): CounterStore {
  const map = new Map<string, number>();
  return {
    async incr(key) {
      const v = (map.get(key) ?? 0) + 1;
      map.set(key, v);
      return v;
    },
    async decr(key) {
      const v = Math.max(0, (map.get(key) ?? 0) - 1);
      map.set(key, v);
      return v;
    },
    async get(key) {
      return map.get(key) ?? 0;
    },
  };
}

/**
 * Per-installation in-flight slot accounting against a tier cap, keyed by the
 * Redis `tb:` namespace. acquire increments then rolls back if over cap.
 */
export class InstallationConcurrency {
  private readonly cap: number;
  private readonly store: CounterStore;

  constructor(cap: number, store: CounterStore = createInMemoryCounterStore()) {
    this.cap = cap;
    this.store = store;
  }

  async tryAcquire(installationId: string): Promise<boolean> {
    const key = tokenBucketKey(installationId);
    const value = await this.store.incr(key);
    if (value > this.cap) {
      await this.store.decr(key);
      return false;
    }
    return true;
  }

  async release(installationId: string): Promise<void> {
    await this.store.decr(tokenBucketKey(installationId));
  }

  async inFlight(installationId: string): Promise<number> {
    return this.store.get(tokenBucketKey(installationId));
  }
}
