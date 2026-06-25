import { buildFindingBrowser, listRunHistory } from "@gate/dashboard";
import { capabilityScreenshotUrl, mintScreenshotCapability } from "@gate/service/screenshot-capability";
import { deriveArtifactId } from "@gate/types";
import { getQuery } from "@/lib/db";
import { env } from "@/lib/env";
import { loadRunResult } from "@/lib/results";
import { requireInstallation } from "@/lib/session";

const CAP_TTL_MS = 5 * 60 * 1000;

/**
 * Per-run finding browser. Screenshots are rendered via short-lived **capability
 * URLs** (#61) bound to the collision-safe artifact id (#71) — never anonymous
 * `/i` links — so a private repo's screenshots stay private.
 */
export default async function FindingBrowserPage({
  params,
  searchParams,
}: {
  params: Promise<{ installationId: string; runId: string }>;
  searchParams: Promise<{ owner?: string; name?: string }>;
}) {
  const { installationId, runId } = await params;
  await requireInstallation(Number(installationId));
  const { owner, name } = await searchParams;

  if (!owner || !name) return <p>Missing repository context.</p>;

  const runs = await listRunHistory(getQuery(), { owner, name });
  const run = runs.find((r) => r.id === runId);
  if (!run) return <p>Run not found.</p>;

  const result = await loadRunResult(runId);
  if (!result) {
    return (
      <section>
        <h1>PR #{run.prNumber}</h1>
        <p>The stored review result for this run is not available yet.</p>
      </section>
    );
  }

  const browser = buildFindingBrowser(result, {
    baseUrl: env.artifactBaseUrl(),
    installationId,
    owner,
    name,
    prNumber: run.prNumber,
    headSha: run.headSha,
  });

  // Replace the anonymous stable URL with a private-safe capability URL (#61).
  const findings = browser.findings.map((f) => {
    if (!f.screenshotUrl) return f;
    const artifactId = deriveArtifactId({ installationId, owner, name, headSha: run.headSha, findingId: f.id });
    const cap = mintScreenshotCapability(
      { artifactId, installationId, owner, name, exp: Date.now() + CAP_TTL_MS },
      env.capabilitySecret(),
    );
    return { ...f, screenshotUrl: capabilityScreenshotUrl(env.artifactBaseUrl(), artifactId, cap) };
  });

  return (
    <section>
      <h1>
        PR #{run.prNumber} — {browser.grade}
      </h1>
      <p>
        <a href={browser.prUrl}>View PR on GitHub →</a>
      </p>
      <p>{browser.overall}</p>
      {findings.map((f) => (
        <article key={f.id} style={{ borderTop: "1px solid #eee", padding: "12px 0" }}>
          <strong>
            [{f.severity}] {f.title}
          </strong>
          <p>{f.description}</p>
          {f.suggestion && <p style={{ color: "#555" }}>Suggestion: {f.suggestion}</p>}
          {f.screenshotUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={f.screenshotUrl} alt={f.title} style={{ maxWidth: "100%", border: "1px solid #eee" }} />
          )}
        </article>
      ))}
    </section>
  );
}
