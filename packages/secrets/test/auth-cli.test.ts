import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_USAGE, type AuthCliIo, readFlag, runAuthCli } from "../src/cli/auth-cli.js";
import { openStorageState } from "../src/storage-state.js";
import { LocalKms } from "../src/kms.js";

const EXAMPLE_FIXTURE = fileURLToPath(new URL("../fixtures/storageState.example.json", import.meta.url));

interface Recorder extends AuthCliIo {
  out: string[];
  err: string[];
  written: Map<string, string>;
}

function recorder(files: Record<string, string>, passphrase?: string): Recorder {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  return {
    out,
    err,
    written,
    passphrase,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    readFile: (path) => {
      const contents = files[path];
      if (contents === undefined) {
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
      return contents;
    },
    writeFile: (path, contents) => void written.set(path, contents),
  };
}

const REAL_FIXTURE = readFileSync(EXAMPLE_FIXTURE, "utf8");

describe("readFlag", () => {
  it("reads --name value and --name=value", () => {
    expect(readFlag(["--input", "a.json"], "input")).toBe("a.json");
    expect(readFlag(["--input=a.json"], "input")).toBe("a.json");
  });

  it("treats a following flag (or nothing) as a missing value", () => {
    expect(readFlag(["--input", "--origins", "https://a"], "input")).toBeUndefined();
    expect(readFlag(["--input"], "input")).toBeUndefined();
    expect(readFlag([], "input")).toBeUndefined();
  });
});

describe("shipped example storageState", () => {
  it("is a Playwright storageState the CLI accepts as printed in the README", async () => {
    const io = recorder({ [EXAMPLE_FIXTURE]: REAL_FIXTURE });
    const code = await runAuthCli(
      ["--input", EXAMPLE_FIXTURE, "--origins", "https://app.acme.com", "--out", "sealed.json"],
      io,
    );

    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out).toEqual(["Sealed storageState -> sealed.json (1 cookies, 1 origins, origin-scoped)."]);
  });

  it("seals the cookie value out of the artifact and back again", async () => {
    const io = recorder({ [EXAMPLE_FIXTURE]: REAL_FIXTURE }, "test-passphrase-0123456789");
    await runAuthCli(["--input", EXAMPLE_FIXTURE, "--origins", "https://app.acme.com"], io);

    const sealed = io.written.get("storageState.sealed.json");
    expect(sealed).toBeDefined();
    expect(sealed).not.toContain("example-not-a-real-session-value");
    const parsed = JSON.parse(sealed as string) as Parameters<typeof openStorageState>[0];
    expect(Object.keys(parsed).sort()).toEqual(["authTag", "ciphertext", "iv", "keyId", "wrappedDek"]);

    const reopened = await openStorageState(parsed, LocalKms.fromPassphrase("test-passphrase-0123456789"));
    expect(reopened.cookies[0]?.value).toBe("example-not-a-real-session-value");
  });
});

describe("runAuthCli input handling", () => {
  let io: Recorder;
  beforeEach(() => {
    io = recorder({ "state.json": REAL_FIXTURE });
  });

  it("prints usage for --help and exits 0", async () => {
    expect(await runAuthCli(["--help"], io)).toBe(0);
    expect(io.out.join("\n")).toBe(AUTH_USAGE);
  });

  it("explains a missing file in one line instead of throwing ENOENT", async () => {
    const code = await runAuthCli(["--input", "missing.json", "--origins", "https://app.acme.com"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("cannot read --input: no such file: missing.json");
    expect(io.err.join("\n")).not.toContain("at ");
  });

  it("requires --input and --origins, printing usage", async () => {
    expect(await runAuthCli(["--input", "state.json"], io)).toBe(1);
    expect(io.err.join("\n")).toContain("--input and --origins are both required");
    expect(io.err.join("\n")).toContain("usage: designreview auth");
  });

  it("rejects invalid JSON with a one-line message", async () => {
    const bad = recorder({ "state.json": "{not json" });
    expect(await runAuthCli(["--input", "state.json", "--origins", "https://app.acme.com"], bad)).toBe(1);
    expect(bad.err.join("\n")).toContain("is not valid JSON");
  });

  it("rejects JSON that is not a storageState", async () => {
    const bad = recorder({ "state.json": JSON.stringify({ cookies: [] }) });
    expect(await runAuthCli(["--input", "state.json", "--origins", "https://app.acme.com"], bad)).toBe(1);
    expect(bad.err.join("\n")).toContain('expected an object with "cookies" and "origins" arrays');
    expect(bad.written.size).toBe(0);
  });

  it("warns when the origin allowlist matches no cookie", async () => {
    const code = await runAuthCli(["--input", "state.json", "--origins", "https://other.example"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("(0 cookies, 0 origins, origin-scoped)");
    expect(io.err.join("\n")).toContain("matched --origins https://other.example");
  });
});
