import { buildAuthorizeUrl, generateOAuthState } from "@gate/dashboard";
import { NextResponse } from "next/server";
import { OAUTH_STATE_COOKIE, env } from "@/lib/env";

/** Start the GitHub OAuth round-trip: set a CSRF state cookie, redirect to GitHub. */
export function GET(): NextResponse {
  const state = generateOAuthState();
  const url = buildAuthorizeUrl({
    clientId: env.githubClientId(),
    redirectUri: `${env.baseUrl()}/api/auth/callback`,
    state,
    scopes: ["read:user"],
  });
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
