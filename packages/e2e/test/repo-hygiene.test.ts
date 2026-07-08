import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

describe("repository dependency hygiene", () => {
  it("keeps pnpm security overrides in supported workspace settings", () => {
    const packageJson = JSON.parse(readFileSync(root("package.json"), "utf8")) as {
      packageManager?: string;
      pnpm?: unknown;
    };
    const workspace = readFileSync(root("pnpm-workspace.yaml"), "utf8");

    expect(packageJson.pnpm).toBeUndefined();
    expect(packageJson.packageManager).toBe("pnpm@10.34.3");
    expect(workspace).toContain("overrides:");
    expect(workspace).toContain("vite: 6.4.3");
    expect(workspace).toContain("ioredis: ^5.11.1");
    expect(workspace).toContain("allowBuilds:");
    expect(workspace).toContain("esbuild: true");
    expect(workspace).toContain("msgpackr-extract: true");
  });
});
