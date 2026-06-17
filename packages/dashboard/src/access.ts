import type { DashboardSession } from "./session.js";

/**
 * Installation-scoped access (TRD §13, §8): a session may only see data for the
 * installations the user belongs to. This complements Postgres RLS (#50) —
 * defense in depth at the dashboard edge.
 */
export function canAccessInstallation(session: DashboardSession, installationId: number): boolean {
  return session.installationIds.includes(installationId);
}

/** Keep only the requested installation ids the session may access. */
export function filterAccessibleInstallations(
  session: DashboardSession,
  requested: number[],
): number[] {
  return requested.filter((id) => canAccessInstallation(session, id));
}

/** Throw if the session may not access the installation (route guard). */
export function assertInstallationAccess(session: DashboardSession, installationId: number): void {
  if (!canAccessInstallation(session, installationId)) {
    throw new Error(`forbidden: no access to installation ${installationId}`);
  }
}
