import { createHash } from "node:crypto";

/**
 * Collision-safe stable-screenshot artifact identity (#71). The engine's
 * `findingId` is only run-local (the golden fixture reuses `f_001`), so it can
 * never key the stable `/i/<id>.png` route or an authorization decision. The
 * artifact id is the SHA-256 of the full ownership identity, which makes it
 * collision-resistant across runs/repos, deterministic (so any layer — delivery,
 * dashboard, the registry — derives the same id without a lookup), and
 * unguessable. It lives in `@gate/types` because both the App service (registry +
 * route) and the dashboard (finding views) must produce identical ids.
 */
export interface ArtifactScope {
  installationId: string;
  owner: string;
  name: string;
  headSha: string;
  findingId: string;
}

export function deriveArtifactId(scope: ArtifactScope): string {
  return createHash("sha256")
    .update([scope.installationId, scope.owner, scope.name, scope.headSha, scope.findingId].join("\n"))
    .digest("hex");
}
