import { readFileSync, writeFileSync } from "node:fs";
import { LocalKms } from "../kms.js";
import { prepareStorageStateArtifact, type StorageState } from "../storage-state.js";

/**
 * `npx designreview auth` wizard (TRD §4.3). Records the login (via the capture
 * repo's Playwright flow, #25 — produces a storageState JSON), then origin-scopes
 * and encrypts it under the tenant key, writing the sealed artifact to store per
 * repo. Usage:
 *   designreview auth --input storageState.json --origins https://app.acme.com --out sealed.json
 * Production resolves the tenant CMK from a managed KMS; this CLI uses a
 * passphrase-derived LocalKms for local/dev.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const input = arg("input");
  const out = arg("out") ?? "storageState.sealed.json";
  const origins = (arg("origins") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const keyId = arg("tenant") ?? "tenant:local";
  const passphrase = process.env.GATE_KMS_PASSPHRASE ?? "local-dev-passphrase-change-me";

  if (!input || origins.length === 0) {
    console.error("usage: designreview auth --input <storageState.json> --origins <https://app,...> [--out <file>] [--tenant <id>]");
    process.exit(1);
  }

  const state = JSON.parse(readFileSync(input, "utf8")) as StorageState;
  const artifact = await prepareStorageStateArtifact({
    state,
    allowedOrigins: origins,
    keyId,
    kms: LocalKms.fromPassphrase(passphrase),
  });
  writeFileSync(out, JSON.stringify(artifact.sealed, null, 2));
  console.log(`Sealed storageState -> ${out} (${artifact.cookieCount} cookies, ${artifact.originCount} origins, origin-scoped).`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
