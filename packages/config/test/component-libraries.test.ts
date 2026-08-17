import { describe, expect, it } from "vitest";
import { COMPONENT_LIBRARY_IDS, detectComponentLibraryIds } from "../src/index.js";

/**
 * Gate is the side that holds the repository, so Gate is the side that can
 * answer which component library it is built with. The engine cannot: its
 * hosted path has no checkout, which is why every hosted review used to be
 * grounded on tokens and brand alone.
 *
 * The file being read is a pull request's own `package.json`, which on a fork is
 * untrusted, so the rules here are deliberately narrow: read dependency names,
 * map them to a closed set of ids, and never fail a review over what the file
 * contains.
 */

const pkg = (sections: Record<string, Record<string, string>>): string => JSON.stringify(sections);

describe("detectComponentLibraryIds", () => {
  it("detects shadcn (its cva signature) and Radix primitives", () => {
    expect(
      detectComponentLibraryIds(
        pkg({ dependencies: { "class-variance-authority": "^0.7.0", "@radix-ui/react-dialog": "^1" } }),
      ),
    ).toEqual(["shadcn/ui", "radix"]);
  });

  it("detects MUI, Chakra and Mantine from any dependency section", () => {
    expect(detectComponentLibraryIds(pkg({ dependencies: { "@mui/material": "^5" } }))).toEqual(["mui"]);
    expect(detectComponentLibraryIds(pkg({ devDependencies: { "@chakra-ui/react": "^2" } }))).toEqual([
      "chakra",
    ]);
    expect(detectComponentLibraryIds(pkg({ peerDependencies: { "@mantine/core": "^7" } }))).toEqual([
      "mantine",
    ]);
  });

  it("names nothing for a repository that uses none of them", () => {
    expect(detectComponentLibraryIds(pkg({ dependencies: { react: "^18", lodash: "^4" } }))).toEqual([]);
    expect(detectComponentLibraryIds("{}")).toEqual([]);
  });

  it("never throws on a manifest a pull request controls", () => {
    // Every one of these means the same thing to a review: no ids, so no
    // addenda, so a review grounded on tokens and brand exactly as before.
    // Detection is grounding, not a precondition, and a malformed manifest must
    // not be able to fail somebody's design review.
    expect(detectComponentLibraryIds(null)).toEqual([]);
    expect(detectComponentLibraryIds(undefined)).toEqual([]);
    expect(detectComponentLibraryIds("")).toEqual([]);
    expect(detectComponentLibraryIds("not json {")).toEqual([]);
    expect(detectComponentLibraryIds("[1, 2, 3]")).toEqual([]);
    expect(detectComponentLibraryIds("null")).toEqual([]);
    expect(detectComponentLibraryIds('{"dependencies": "@mui/material"}')).toEqual([]);
    expect(detectComponentLibraryIds('{"dependencies": ["@mui/material"]}')).toEqual([]);
  });

  it("refuses to parse a document too large to be a manifest", () => {
    const padded = JSON.stringify({
      dependencies: { "@mui/material": "^5" },
      description: "x".repeat(1_000_001),
    });
    expect(detectComponentLibraryIds(padded)).toEqual([]);
  });

  it("emits ids from the closed vocabulary the engine shares", () => {
    const all = detectComponentLibraryIds(
      pkg({
        dependencies: {
          "class-variance-authority": "^0.7.0",
          "@radix-ui/react-dialog": "^1",
          "@mui/material": "^5",
          "@chakra-ui/react": "^2",
          "@mantine/core": "^7",
        },
      }),
    );
    expect(all).toEqual([...COMPONENT_LIBRARY_IDS]);
  });
});
