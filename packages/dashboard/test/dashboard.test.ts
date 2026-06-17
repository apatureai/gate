import { describe, expect, it } from "vitest";
import {
  assertInstallationAccess,
  buildAuthorizeUrl,
  canAccessInstallation,
  type DashboardSession,
  exchangeCodeForToken,
  fetchUserInstallations,
  filterAccessibleInstallations,
  mintSession,
  NAV_ITEMS,
  verifySession,
} from "../src/index.js";

const SECRET = "dashboard-secret";
const session: DashboardSession = {
  userId: 1,
  login: "dev",
  installationIds: [10, 20],
  exp: 9_999_999_999_999,
};

describe("OAuth", () => {
  it("builds the authorize URL with state + scopes", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://gate.app/cb", state: "xyz" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.get("scope")).toBe("read:user");
  });

  it("exchanges a code for a token", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })) as unknown as typeof fetch;
    const token = await exchangeCodeForToken("code", {
      clientId: "c",
      clientSecret: "s",
      redirectUri: "https://gate.app/cb",
      fetchImpl,
    });
    expect(token).toBe("tok");
  });

  it("lists the user's installation ids", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ installations: [{ id: 10 }, { id: 20 }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchUserInstallations("tok", fetchImpl)).toEqual([10, 20]);
  });
});

describe("session", () => {
  it("round-trips and rejects tampering/expiry", () => {
    const token = mintSession(session, SECRET);
    expect(verifySession(token, SECRET)).toMatchObject({ ok: true });
    expect(verifySession(token, "other").ok).toBe(false);
    expect(verifySession(mintSession({ ...session, exp: 1000 }, SECRET), SECRET, 2000)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });
});

describe("installation-scoped access", () => {
  it("scopes to the user's installations", () => {
    expect(canAccessInstallation(session, 10)).toBe(true);
    expect(canAccessInstallation(session, 99)).toBe(false);
    expect(filterAccessibleInstallations(session, [10, 99, 20])).toEqual([10, 20]);
    expect(() => assertInstallationAccess(session, 99)).toThrow(/forbidden/);
  });
});

describe("navigation shell", () => {
  it("exposes the nav items", () => {
    expect(NAV_ITEMS.map((n) => n.key)).toEqual(["runs", "findings", "feedback", "config", "billing"]);
  });
});
