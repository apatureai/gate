import { describe, expect, it } from "vitest";
import { LocalKms } from "../src/kms.js";
import {
  openStorageState,
  originScopeStorageState,
  prepareStorageStateArtifact,
  sealStorageState,
  type StorageState,
} from "../src/storage-state.js";

const kms = LocalKms.fromPassphrase("tenant-root-passphrase-1234567890");

const state: StorageState = {
  cookies: [
    { name: "session", value: "s", domain: "app.acme.com" },
    { name: "wild", value: "w", domain: ".acme.com" },
    { name: "evil", value: "e", domain: "tracker.example.com" },
  ],
  origins: [
    { origin: "https://app.acme.com", localStorage: [{ name: "tok", value: "1" }] },
    { origin: "https://evil.example.com", localStorage: [{ name: "x", value: "2" }] },
  ],
};

describe("originScopeStorageState", () => {
  it("keeps only cookies/origins for the allowed origins", () => {
    const scoped = originScopeStorageState(state, ["https://app.acme.com"]);
    expect(scoped.cookies.map((c) => c.name).sort()).toEqual(["session", "wild"]); // .acme.com covers app.acme.com
    expect(scoped.cookies.find((c) => c.name === "evil")).toBeUndefined();
    expect(scoped.origins.map((o) => o.origin)).toEqual(["https://app.acme.com"]);
  });
});

describe("seal/open storageState", () => {
  it("round-trips under the tenant key and fails under another", async () => {
    const sealed = await sealStorageState(state, "tenant:acme", kms);
    expect(JSON.stringify(sealed)).not.toContain("session");
    expect(await openStorageState(sealed, kms)).toEqual(state);
    await expect(openStorageState({ ...sealed, keyId: "tenant:other" }, kms)).rejects.toThrow();
  });
});

describe("prepareStorageStateArtifact", () => {
  it("scopes then seals; opening yields the scoped state", async () => {
    const artifact = await prepareStorageStateArtifact({
      state,
      allowedOrigins: ["https://app.acme.com"],
      keyId: "tenant:acme",
      kms,
    });
    expect(artifact.cookieCount).toBe(2);
    expect(artifact.originCount).toBe(1);
    const opened = await openStorageState(artifact.sealed, kms);
    expect(opened.cookies.every((c) => c.domain.includes("acme.com"))).toBe(true);
    expect(opened.origins).toHaveLength(1);
  });
});
