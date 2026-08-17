/**
 * Which component library the repository under review is built with (verdict
 * limitation, closed here).
 *
 * The critique engine appends a library-specific rubric note to its deep prompt
 * (judge spacing against MUI's 8px scale, expect Radix's ARIA semantics and
 * app-owned styling). Its CLI works that out by reading the repository's
 * `package.json`. The hosted engine cannot: it holds no checkout of your
 * repository, and until now the review request had no field for the answer, so
 * every hosted review was grounded on tokens and brand alone.
 *
 * Gate is the side that HAS the repository, on both paths: the Action runs in
 * the checkout, and the App can read a file at the PR's head through the
 * installation token. So Gate detects, and names what it found.
 *
 * What crosses the wire is IDS, never prose. The rubric text stays owned by the
 * engine, so nothing read out of a pull request's own `package.json` can be
 * written into a model prompt: a hostile PR can at most claim to use Chakra.
 * The vocabulary below is the engine's (`COMPONENT_LIBRARY_IDS` in verdict's
 * `packages/context`), and it is the whole agreement between the two sides.
 */

/** Ids the critique engine has a rubric addendum for. */
export const COMPONENT_LIBRARY_IDS = [
  "shadcn/ui",
  "radix",
  "mui",
  "chakra",
  "mantine",
] as const;

export type ComponentLibraryId = (typeof COMPONENT_LIBRARY_IDS)[number];

interface Detector {
  id: ComponentLibraryId;
  match: (dependencyNames: Set<string>) => boolean;
}

const hasPrefix = (names: Set<string>, prefix: string): boolean => {
  for (const name of names) if (name === prefix || name.startsWith(prefix)) return true;
  return false;
};

/**
 * The same signatures the engine's own detector uses, in the same order, so a
 * repository reviewed through Gate and the same repository reviewed with the
 * engine's CLI name the same libraries.
 */
const DETECTORS: Detector[] = [
  // shadcn is copy-pasted rather than installed; its signature is cva.
  { id: "shadcn/ui", match: (deps) => deps.has("class-variance-authority") },
  { id: "radix", match: (deps) => hasPrefix(deps, "@radix-ui/") },
  { id: "mui", match: (deps) => hasPrefix(deps, "@mui/") },
  { id: "chakra", match: (deps) => hasPrefix(deps, "@chakra-ui/") },
  { id: "mantine", match: (deps) => hasPrefix(deps, "@mantine/") },
];

/**
 * The largest `package.json` worth parsing.
 *
 * This file comes from the pull request, which on a fork is untrusted input, and
 * the only thing Gate wants from it is a list of dependency names. A
 * multi-megabyte document is not a manifest, and refusing to parse it costs a
 * review its component-library grounding and nothing else.
 */
const MAX_PACKAGE_JSON_BYTES = 1_000_000;

interface PackageJsonLike {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

function dependencyNames(pkg: PackageJsonLike): Set<string> {
  const names = new Set<string>();
  for (const section of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
    if (section && typeof section === "object" && !Array.isArray(section)) {
      for (const name of Object.keys(section)) names.add(name);
    }
  }
  return names;
}

/**
 * Detect component-library ids from a repository's `package.json` text.
 *
 * Never throws. A missing file, a file that is not JSON, a JSON document that is
 * not an object, and a repository that uses none of these libraries all mean the
 * same thing to a review: no ids, so no addenda, so a review grounded on tokens
 * and brand exactly as before. Detection is best-effort grounding, and a
 * malformed manifest must not be able to fail a pull request's design review.
 */
export function detectComponentLibraryIds(packageJsonText: string | null | undefined): ComponentLibraryId[] {
  if (!packageJsonText || packageJsonText.length > MAX_PACKAGE_JSON_BYTES) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const names = dependencyNames(parsed as PackageJsonLike);
  return DETECTORS.filter((detector) => detector.match(names)).map((detector) => detector.id);
}
