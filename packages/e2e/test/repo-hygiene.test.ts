import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const REPO_ROOT = root(".");

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".next", "out"]);

function markdownFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      markdownFiles(join(dir, entry.name), found);
    } else if (entry.name.endsWith(".md")) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

/** Every fenced yaml block in a file, with the 1-based line the fence opens on. */
function yamlBlocks(text: string): { body: string; line: number }[] {
  const blocks: { body: string; line: number }[] = [];
  const lines = text.split("\n");
  let open: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (open === null) {
      if (/^\s*```ya?ml\s*$/.test(line)) open = i;
    } else if (/^\s*```\s*$/.test(line)) {
      blocks.push({ body: lines.slice(open + 1, i).join("\n"), line: open + 1 });
      open = null;
    }
  }
  return blocks;
}

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

  it("keeps root README dashboard guidance single-sourced", () => {
    const readme = readFileSync(root("README.md"), "utf8");
    const dashboardRows = readme.match(/^\| `dashboard` \| Next\.js \(app-router\) shell/gm) ?? [];
    const rootGateNotes = readme.match(/`apps\/dashboard` is \*\*not\*\* part of this root gate/g) ?? [];

    expect(dashboardRows).toHaveLength(1);
    expect(rootGateNotes).toHaveLength(1);
    expect(readme).toContain("built with its own isolated `next build` CI job");
    expect(readme).toContain("pnpm build\ncd apps/dashboard\nnpm ci\nnpm run build");
  });
});

/**
 * The workflow snippet is the single most copied thing in this repository, and a
 * Marketplace listing links straight at the file that carries it. A previous
 * round corrected `packages/action/README.md` and left the root README, the
 * landing page, still printing a `${{ steps.deploy.outputs.preview-url }}` that
 * referred to a step no reader had, above a `config-path:` that a missing
 * `actions/checkout` silently ignores. Pasted verbatim it produced an empty
 * preview URL, an empty workspace, and no error saying so.
 *
 * So this does not pin one file: it finds every documented Gate workflow in the
 * repository and checks that it would actually run. A snippet added to a third
 * doc later gets the same treatment without anyone remembering to add it here.
 */
describe("every documented Gate workflow snippet is runnable as written", () => {
  const snippets = markdownFiles(REPO_ROOT).flatMap((file) =>
    yamlBlocks(readFileSync(file, "utf8"))
      .filter((block) => /uses:\s*apatureai\/gate@/.test(block.body))
      .map((block) => ({
        where: relative(REPO_ROOT, file),
        line: block.line,
        body: block.body,
      })),
  );

  it("finds the snippets, so a rename cannot make this suite vacuously green", () => {
    // The landing page is named explicitly because it is the file that was
    // wrong: a suite that silently found only packages/action/README.md would
    // have passed through the whole blocker.
    expect(snippets.map((s) => s.where).sort()).toEqual([
      "README.md",
      "packages/action/README.md",
    ]);
  });

  it.each(snippets)("$where defines every step it reads an output from", ({ body }) => {
    const defined = new Set([...body.matchAll(/^\s*-?\s*id:\s*(\S+)/gm)].map((m) => m[1]));
    const referenced = [...body.matchAll(/\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs/g)].map(
      (m) => m[1],
    );
    // Not just "non-empty": the bug was a reference with no definition anywhere,
    // which GitHub resolves to the empty string without warning.
    expect(referenced.length).toBeGreaterThan(0);
    for (const id of referenced) expect([...defined]).toContain(id);
  });

  it.each(snippets)("$where checks out the workspace it reads files from", ({ body }) => {
    // config-path and preview-command both read from the runner workspace. With
    // no checkout the workspace is empty, .gate.yml is silently ignored, and the
    // run reports on default config as though that were what you asked for.
    const readsWorkspace = /config-path:|preview-command:\s*\S/.test(body);
    if (!readsWorkspace) return;
    expect(body).toMatch(/uses:\s*actions\/checkout@/);
  });

  it.each(snippets)("$where never triggers on pull_request_target", ({ body }) => {
    // Comments are stripped first: both snippets say "NOT pull_request_target"
    // in a comment on purpose, and the thing being checked is the trigger.
    const active = body
      .split("\n")
      .map((line) => line.replace(/#.*$/, ""))
      .join("\n");
    expect(active).not.toContain("pull_request_target");
  });
});
