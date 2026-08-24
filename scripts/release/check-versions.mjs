#!/usr/bin/env node
// Guard against the two version-drift mistakes that shipped a 0.1.5 with no
// matching tag: a partial version bump (root moved, a workspace package did
// not) and a bump with no CHANGELOG entry.
//
// Checks, against the repository root:
//   1. every workspace package.json has the same "version" as the root manifest;
//   2. CHANGELOG.md has a "## [<version>]" section for that version.
//
// It does NOT require a matching git tag to exist: on the pull request that
// bumps the version the tag legitimately does not exist yet. Cutting the tag,
// the GitHub release, and the moving "v1" alias is automated by
// .github/workflows/release.yml once the bump lands on main.
//
// Exits non-zero on the first failure so CI fails loudly.

import { readFile } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

const rootPkg = await readJson(resolve(repoRoot, "package.json"));
const version = rootPkg.version;
if (typeof version !== "string" || version.length === 0) {
  process.stderr.write("root package.json has no version\n");
  process.exit(1);
}

const errors = [];

// 1. workspace package versions
const packagesDir = resolve(repoRoot, "packages");
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(packagesDir, entry.name, "package.json");
  if (!existsSync(manifestPath)) continue;
  const pkg = await readJson(manifestPath);
  if (pkg.version !== version) {
    errors.push(
      `packages/${entry.name} is at ${pkg.version}, root is ${version} ` +
        `(bump every workspace manifest together)`,
    );
  }
}

// 2. CHANGELOG entry
const changelog = await readFile(resolve(repoRoot, "CHANGELOG.md"), "utf8");
const heading = new RegExp(
  `^##\\s+\\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`,
  "m",
);
if (!heading.test(changelog)) {
  errors.push(
    `CHANGELOG.md has no "## [${version}]" section ` +
      `(add the release notes in the same pull request as the bump)`,
  );
}

if (errors.length > 0) {
  process.stderr.write("version consistency check failed:\n");
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}

process.stdout.write(`version ${version} is consistent across the workspace and CHANGELOG\n`);
