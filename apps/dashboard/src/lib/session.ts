import { assertInstallationAccess, verifySession, type DashboardSession } from "@gate/dashboard";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, env } from "./env";

/** Read + verify the signed session cookie, or null when absent/invalid. */
export async function getSession(): Promise<DashboardSession | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const result = verifySession(token, env.sessionSecret());
  return result.ok ? result.session : null;
}

/** Require a session; redirect to the OAuth login when there isn't one. */
export async function requireSession(): Promise<DashboardSession> {
  const session = await getSession();
  if (!session) redirect("/api/auth/login");
  return session;
}

/**
 * Require a session AND that it may access `installationId`. The access check
 * throws (→ the route's error boundary renders a forbidden state); RLS (#50) is
 * the deeper backstop at the DB.
 */
export async function requireInstallation(installationId: number): Promise<DashboardSession> {
  const session = await requireSession();
  assertInstallationAccess(session, installationId);
  return session;
}
