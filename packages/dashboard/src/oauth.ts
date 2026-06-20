import { randomUUID } from "node:crypto";

/**
 * GitHub OAuth for the hosted dashboard (TRD §13, §7). Pure flow helpers (URL
 * building, code exchange, installation listing) with an injected fetch, so the
 * Next.js shell is a thin consumer and the logic is unit-tested.
 */
export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}

export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("scope", (options.scopes ?? ["read:user"]).join(" "));
  return url.toString();
}

/** CSRF state for the OAuth round-trip; store it and compare on callback. */
export function generateOAuthState(): string {
  return randomUUID();
}

export interface OAuthExchangeDeps {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

/** Exchange an authorization code for a user access token. */
export async function exchangeCodeForToken(code: string, deps: OAuthExchangeDeps): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: deps.clientId,
      client_secret: deps.clientSecret,
      code,
      redirect_uri: deps.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`oauth token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) throw new Error(`oauth token exchange error: ${body.error ?? "no token"}`);
  return body.access_token;
}

/** List the installation ids the authenticated user can access. */
export async function fetchUserInstallations(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number[]> {
  const res = await fetchImpl("https://api.github.com/user/installations", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "apature-gate-dashboard",
    },
  });
  if (!res.ok) throw new Error(`fetch installations failed: ${res.status}`);
  const body = (await res.json()) as { installations?: Array<{ id: number }> };
  return (body.installations ?? []).map((i) => i.id);
}
