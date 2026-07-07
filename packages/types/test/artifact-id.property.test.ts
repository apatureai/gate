/**
 * Property-based laws for the collision-safe artifact identity (#71). The id
 * keys the stable `/i/<id>.png` route and authorization binding, so its
 * contract is: deterministic, and injective over the real input domain
 * (GitHub identifiers / hex SHAs / engine finding ids — none contain "\n",
 * the join delimiter). The last test pins that domain boundary explicitly so
 * a future component with free-form content can't silently weaken identity.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveArtifactId, type ArtifactScope } from "../src/index.js";

const RUNS = { numRuns: 500 };

/** Newline-free component, the real domain (GitHub ids, hex SHAs, finding ids). */
const component = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => !s.includes("\n"));

const scopeArb: fc.Arbitrary<ArtifactScope> = fc.record({
  installationId: component,
  owner: component,
  name: component,
  headSha: component,
  findingId: component,
});

describe("deriveArtifactId properties", () => {
  it("is deterministic and shape-stable (64 lowercase hex chars)", () => {
    fc.assert(
      fc.property(scopeArb, (scope) => {
        const id = deriveArtifactId(scope);
        expect(deriveArtifactId({ ...scope })).toBe(id);
        expect(id).toMatch(/^[0-9a-f]{64}$/);
      }),
      RUNS,
    );
  });

  it("distinct scopes (any differing component) derive distinct ids", () => {
    fc.assert(
      fc.property(scopeArb, scopeArb, (a, b) => {
        const same =
          a.installationId === b.installationId &&
          a.owner === b.owner &&
          a.name === b.name &&
          a.headSha === b.headSha &&
          a.findingId === b.findingId;
        expect(deriveArtifactId(a) === deriveArtifactId(b)).toBe(same);
      }),
      RUNS,
    );
  });

  it("pins the domain boundary: newline-bearing components CAN collide (never pass them)", () => {
    // ["a\nb", "c"] and ["a", "b\nc"] concatenate identically under the "\n"
    // join. All real components (installation id, owner/name, sha, finding id)
    // are newline-free; this test documents WHY that precondition matters.
    const x = deriveArtifactId({ installationId: "a\nb", owner: "c", name: "n", headSha: "s", findingId: "f" });
    const y = deriveArtifactId({ installationId: "a", owner: "b\nc", name: "n", headSha: "s", findingId: "f" });
    expect(x).toBe(y);
  });
});
