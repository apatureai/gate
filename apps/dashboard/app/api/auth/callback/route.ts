import { exchangeCodeForToken, fetchUserInstallations, mintSession } from "@gate/dashboard";
import { type NextRequest, NextResponse } from "next/server";
import { OAUTH_STATE_COOKIE, SESSION_COOKIE, env } from "@/lib/env";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h

/** Fetch the authenticated user's id + login for the session subject. */
async function fetchUser(token: string): Promise<{ id: number; login: string }> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "apature-gate-dashboard",
    },
  });
  if (!res.ok) throw new Error(`fetch user failed: ${res.status}`);
  const body = (await res.json()) as { id: number; login: string };
  return { id: body.id, login: body.login };
}

/** OAuth callback: verify CSRF state, exchange the code, mint a signed session. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.json({ error: "invalid_oauth_state" }, { status: 400 });
  }

  const token = await exchangeCodeForToken(code, {
    clientId: env.githubClientId(),
    clientSecret: env.githubClientSecret(),
    redirectUri: `${env.baseUrl()}/api/auth/callback`,
  });
  const [user, installationIds] = await Promise.all([fetchUser(token), fetchUserInstallations(token)]);

  const session = mintSession(
    { userId: user.id, login: user.login, installationIds, exp: Date.now() + SESSION_TTL_MS },
    env.sessionSecret(),
  );

  // Land on the first installation, or a chooser when there are several / none.
  const dest = installationIds.length === 1 ? `/${installationIds[0]}` : "/";
  const res = NextResponse.redirect(`${env.baseUrl()}${dest}`);
  res.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  res.cookies.delete(OAUTH_STATE_COOKIE);
  return res;
}
