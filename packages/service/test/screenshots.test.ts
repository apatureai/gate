import { loadGoldenReviewResult } from "@gate/types";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";
import {
  buildRunUrl,
  buildScreenshotRecords,
  capabilityScreenshotUrl,
  createTemplateSignedUrlProvider,
  deriveArtifactId,
  mintScreenshotCapability,
  registerScreenshotRoute,
  type ScreenshotRecord,
  type ScreenshotRegistry,
  stableScreenshotUrl,
} from "../src/index.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function registry(records: ScreenshotRecord[]): ScreenshotRegistry {
  return {
    lookup: async (id) => records.find((r) => r.artifactId === id) ?? null,
  };
}

const signer = { sign: async (key: string) => `https://signed.example.com/${key}?sig=fresh` };
const ART = "art_1";

function record(overrides: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    artifactId: ART,
    findingId: "f_001",
    headSha: "sha1",
    objectKey: "shot_001.png",
    expiresAt: 10_000,
    installationId: "1",
    owner: "acme",
    name: "web",
    visibility: "public",
    ...overrides,
  };
}

describe("GET /i/:id.png — retention + basics", () => {
  it("302s to a freshly-signed URL for a live public screenshot (anonymous)", async () => {
    app = buildServer();
    registerScreenshotRoute(app, { registry: registry([record()]), signer, now: () => 5_000 });
    const res = await app.inject({ method: "GET", url: `/i/${ART}.png` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://signed.example.com/shot_001.png?sig=fresh");
  });

  it("404s for an unknown artifact", async () => {
    app = buildServer();
    registerScreenshotRoute(app, { registry: registry([]), signer });
    expect((await app.inject({ method: "GET", url: "/i/missing.png" })).statusCode).toBe(404);
  });

  it("410 tombstones after the retention window", async () => {
    app = buildServer();
    registerScreenshotRoute(app, { registry: registry([record({ expiresAt: 1_000 })]), signer, now: () => 9_999 });
    expect((await app.inject({ method: "GET", url: `/i/${ART}.png` })).statusCode).toBe(410);
  });
});

describe("GET /i/:id.png — authorization (#61/#71)", () => {
  const SECRET = "cap-secret";
  let signed = 0;
  const countingSigner = { sign: async (key: string) => (signed++, `https://signed.example.com/${key}`) };
  const capFor = (over: Partial<Parameters<typeof mintScreenshotCapability>[0]> = {}) =>
    mintScreenshotCapability(
      { artifactId: ART, installationId: "1", owner: "acme", name: "web", exp: 100_000, ...over },
      SECRET,
    );

  function appWith(records: ScreenshotRecord[], opts: { authorizer?: boolean } = {}) {
    signed = 0;
    const a = buildServer();
    registerScreenshotRoute(a, {
      registry: registry(records),
      signer: countingSigner,
      capabilitySecret: SECRET,
      now: () => 1_000,
      ...(opts.authorizer
        ? { authorizer: { authorize: (req, rec) => req.headers["x-installation"] === rec.installationId } }
        : {}),
    });
    return a;
  }

  it("denies anonymous access to a private artifact (404, signer never called)", async () => {
    app = appWith([record({ visibility: "private", expiresAt: 10_000 })]);
    const res = await app.inject({ method: "GET", url: `/i/${ART}.png` });
    expect(res.statusCode).toBe(404);
    expect(signed).toBe(0);
  });

  it("allows a valid capability bound to the artifact + installation + repo", async () => {
    app = appWith([record({ visibility: "private", expiresAt: 10_000 })]);
    const res = await app.inject({ method: "GET", url: `/i/${ART}.png?cap=${encodeURIComponent(capFor())}` });
    expect(res.statusCode).toBe(302);
    expect(signed).toBe(1);
  });

  it("rejects a capability minted for another installation (cross-tenant denial)", async () => {
    app = appWith([record({ visibility: "private", expiresAt: 10_000 })]);
    const res = await app.inject({ method: "GET", url: `/i/${ART}.png?cap=${encodeURIComponent(capFor({ installationId: "999" }))}` });
    expect(res.statusCode).toBe(404);
    expect(signed).toBe(0);
  });

  it("rejects a capability for a different repo even at the same artifact id (binding)", async () => {
    app = appWith([record({ visibility: "private", expiresAt: 10_000 })]);
    const res = await app.inject({ method: "GET", url: `/i/${ART}.png?cap=${encodeURIComponent(capFor({ name: "other" }))}` });
    expect(res.statusCode).toBe(404);
    expect(signed).toBe(0);
  });

  it("rejects an expired capability", async () => {
    app = appWith([record({ visibility: "private", expiresAt: 10_000 })]);
    expect((await app.inject({ method: "GET", url: `/i/${ART}.png?cap=${capFor({ exp: 500 })}` })).statusCode).toBe(404);
  });

  it("authorizes a private artifact via an installation-scoped session", async () => {
    app = appWith([record({ visibility: "private", expiresAt: 10_000 })], { authorizer: true });
    const ok = await app.inject({ method: "GET", url: `/i/${ART}.png`, headers: { "x-installation": "1" } });
    expect(ok.statusCode).toBe(302);
    const cross = await app.inject({ method: "GET", url: `/i/${ART}.png`, headers: { "x-installation": "2" } });
    expect(cross.statusCode).toBe(404);
  });
});

describe("deriveArtifactId (#71 collision safety)", () => {
  const base = { installationId: "1", owner: "acme", name: "web", headSha: "sha1", findingId: "f_001" };

  it("is deterministic (idempotent) for the same scope", () => {
    expect(deriveArtifactId(base)).toBe(deriveArtifactId({ ...base }));
  });

  it("produces DISTINCT ids for the same findingId across repos / runs", () => {
    const a = deriveArtifactId(base);
    expect(deriveArtifactId({ ...base, name: "other" })).not.toBe(a); // different repo
    expect(deriveArtifactId({ ...base, headSha: "sha2" })).not.toBe(a); // different run
    expect(deriveArtifactId({ ...base, installationId: "2" })).not.toBe(a); // different tenant
  });
});

describe("URL + record helpers", () => {
  it("builds artifact-keyed public + capability URLs and the dashboard run URL", () => {
    expect(stableScreenshotUrl("https://gate.app/", ART)).toBe("https://gate.app/i/art_1.png");
    expect(capabilityScreenshotUrl("https://gate.app", ART, "tok ax")).toBe("https://gate.app/i/art_1.png?cap=tok%20ax");
    expect(
      buildRunUrl("https://gate.app", {
        installationId: "1",
        owner: "acme",
        name: "web app",
        runId: "run_9",
      }),
    ).toBe("https://gate.app/1/findings/run_9?owner=acme&name=web+app");
  });

  it("builds signed screenshot object URLs from an explicit env template", async () => {
    const signer = createTemplateSignedUrlProvider("https://objects.example/{objectKey}?sig=fresh");
    await expect(signer.sign("jobs/1/shot.png")).resolves.toBe("https://objects.example/jobs%2F1%2Fshot.png?sig=fresh");
  });

  it("rejects a screenshot object URL template without the object key placeholder", () => {
    expect(() => createTemplateSignedUrlProvider("https://objects.example/static.png")).toThrow(/{objectKey}/);
  });

  it("stamps collision-safe artifact ids + retention + ownership on records", () => {
    const result = loadGoldenReviewResult();
    const ownership = { installationId: "1", owner: "acme", name: "web", headSha: "sha1", visibility: "private" as const };
    const records = buildScreenshotRecords(result, 1_000_000, ownership);
    expect(records.length).toBe(result.artifacts.annotatedScreenshots.length);
    expect(records[0]).toMatchObject({ installationId: "1", owner: "acme", name: "web", visibility: "private" });
    expect(records[0]?.expiresAt).toBe(1_000_000 + result.screenshotRetentionSeconds * 1000);
    // The artifact id matches the deterministic derivation for its finding.
    expect(records[0]?.artifactId).toBe(
      deriveArtifactId({ ...ownership, findingId: result.artifacts.annotatedScreenshots[0]!.findingId }),
    );
  });
});
