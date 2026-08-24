#!/usr/bin/env node
// Print the CHANGELOG.md body for one version, for use as GitHub release notes.
//
// Usage: node scripts/release/changelog-section.mjs <version> [changelog-path]
//   <version>        e.g. 0.1.5 (no leading "v")
//   [changelog-path] defaults to CHANGELOG.md at the repository root
//
// Prints the lines between the "## [<version>]" heading and the next "## "
// heading (the heading itself is not printed, since the GitHub release already
// carries the version as its title). Exits non-zero if the section is absent,
// so a release workflow fails loudly rather than publishing empty notes.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const version = process.argv[2];
const changelogPath = process.argv[3]
  ? resolve(process.argv[3])
  : resolve(repoRoot, "CHANGELOG.md");

if (!version) {
  process.stderr.write("usage: changelog-section.mjs <version> [changelog-path]\n");
  process.exit(2);
}

const text = await readFile(changelogPath, "utf8").catch((err) => {
  process.stderr.write(`cannot read ${changelogPath}: ${err.message}\n`);
  process.exit(2);
});

const lines = text.split("\n");
// Match "## [0.1.5]" at the start of a line; the rest of the heading (a date,
// separated by an em dash) is ignored so notes do not depend on it.
const headingFor = (v) =>
  new RegExp(`^##\\s+\\[${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`);
const anyVersionHeading = /^##\s+\[/;

let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (headingFor(version).test(lines[i])) {
    start = i;
    break;
  }
}

if (start === -1) {
  process.stderr.write(
    `CHANGELOG has no "## [${version}]" section in ${changelogPath}\n`,
  );
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (anyVersionHeading.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines.slice(start + 1, end).join("\n").trim();
if (body === "") {
  process.stderr.write(`CHANGELOG section for ${version} is empty\n`);
  process.exit(1);
}

process.stdout.write(body + "\n");
