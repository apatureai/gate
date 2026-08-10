import { readFileSync, writeFileSync } from "node:fs";
import { LocalKms } from "../kms.js";
import { prepareStorageStateArtifact, type StorageState } from "../storage-state.js";

/**
 * `npx gate auth` wizard (TRD §4.3). Records the login (via the capture
 * repo's Playwright flow, #25, which produces a storageState JSON), then origin-scopes
 * and encrypts it under the tenant key, writing the sealed artifact to store per
 * repo. Production resolves the tenant CMK from a managed KMS; this CLI uses a
 * passphrase-derived LocalKms for local/dev.
 *
 * Kept separate from `auth.ts` (the bin) so the whole flow is testable without
 * spawning a process: `auth.ts` only calls `runAuthCli` and sets the exit code.
 */
export const AUTH_USAGE = [
  "usage: gate auth --input <storageState.json> --origins <https://app.acme.com,...>",
  "                 [--out <file>] [--tenant <id>]",
  "",
  "  --input    Playwright storageState JSON to seal (see packages/secrets/fixtures/storageState.example.json)",
  "  --origins  comma-separated origin allowlist; cookies/localStorage outside it are dropped",
  "  --out      where to write the sealed artifact (default: storageState.sealed.json)",
  "  --tenant   key id to seal under (default: tenant:local)",
  "",
  "  Reads GATE_KMS_PASSPHRASE for the local key-provider passphrase.",
].join("\n");

export interface AuthCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  passphrase: string | undefined;
}

export const defaultAuthCliIo = (): AuthCliIo => ({
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, contents) => writeFileSync(path, contents),
  passphrase: process.env.GATE_KMS_PASSPHRASE,
});

/** `--name value` or `--name=value`; a following flag counts as no value. */
export function readFlag(argv: string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function describeReadFailure(path: string, err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOENT") return `cannot read --input: no such file: ${path}`;
  if (code === "EISDIR") return `cannot read --input: ${path} is a directory`;
  if (code === "EACCES") return `cannot read --input: permission denied: ${path}`;
  return `cannot read --input ${path}: ${err instanceof Error ? err.message : String(err)}`;
}

/** Reject anything that is not a Playwright storageState before we seal it. */
function parseStorageState(raw: string, path: string): StorageState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--input ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const state = value as Partial<StorageState> | null;
  if (!state || typeof state !== "object" || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    throw new Error(
      `--input ${path} is not a Playwright storageState (expected an object with "cookies" and "origins" arrays)`,
    );
  }
  return state as StorageState;
}

/** Returns the process exit code; never throws for user-input problems. */
export async function runAuthCli(argv: string[], io: AuthCliIo = defaultAuthCliIo()): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.log(AUTH_USAGE);
    return 0;
  }

  const input = readFlag(argv, "input");
  const out = readFlag(argv, "out") ?? "storageState.sealed.json";
  const origins = (readFlag(argv, "origins") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const keyId = readFlag(argv, "tenant") ?? "tenant:local";
  const passphrase = io.passphrase ?? "local-dev-passphrase-change-me";

  if (!input || origins.length === 0) {
    io.error(`error: --input and --origins are both required.\n\n${AUTH_USAGE}`);
    return 1;
  }

  let raw: string;
  try {
    raw = io.readFile(input);
  } catch (err) {
    io.error(`error: ${describeReadFailure(input, err)}`);
    return 1;
  }

  let state: StorageState;
  try {
    state = parseStorageState(raw, input);
  } catch (err) {
    io.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const artifact = await prepareStorageStateArtifact({
    state,
    allowedOrigins: origins,
    keyId,
    kms: LocalKms.fromPassphrase(passphrase),
  });

  try {
    io.writeFile(out, JSON.stringify(artifact.sealed, null, 2));
  } catch (err) {
    io.error(`error: cannot write --out ${out}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  io.log(
    `Sealed storageState -> ${out} (${artifact.cookieCount} cookies, ${artifact.originCount} origins, origin-scoped).`,
  );
  if (artifact.cookieCount === 0) {
    io.error(`warning: no cookie in ${input} matched --origins ${origins.join(",")}; the sealed state has no session.`);
  }
  return 0;
}
