/**
 * Fork-PR guard (TRD §8). Auth `storageState` must be disabled for fork PRs so a
 * hostile fork can never exfiltrate authenticated session state.
 */

/** Returns the storage state to use, or null when the PR is from a fork. */
export function storageStateForPr(
  storageState: string | null,
  ctx: { isFork: boolean },
): string | null {
  return ctx.isFork ? null : storageState;
}

/** Throws if storage state is being used on a fork PR. Defense-in-depth. */
export function assertStorageStateAllowed(isFork: boolean): void {
  if (isFork) {
    throw new Error("storageState is disabled for fork PRs (TRD §8)");
  }
}
