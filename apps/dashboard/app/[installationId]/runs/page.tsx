import { listRunHistory, prUrl } from "@gate/dashboard";
import { getQuery } from "@/lib/db";
import { requireInstallation } from "@/lib/session";

/** Per-repo run history (newest first), via the core `listRunHistory` (RLS-scoped). */
export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ installationId: string }>;
  searchParams: Promise<{ owner?: string; name?: string }>;
}) {
  const { installationId } = await params;
  await requireInstallation(Number(installationId));
  const { owner, name } = await searchParams;

  if (!owner || !name) {
    return <p>Select a repository from the installation page to see its runs.</p>;
  }

  const runs = await listRunHistory(getQuery(), { owner, name });

  return (
    <section>
      <h1>
        Runs — {owner}/{name}
      </h1>
      {runs.length === 0 ? (
        <p>No reviews recorded yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th>PR</th>
              <th>Grade</th>
              <th>Model</th>
              <th>UI-DNA</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} style={{ borderBottom: "1px solid #f3f3f3" }}>
                <td>
                  <a href={prUrl(owner, name, run.prNumber)}>#{run.prNumber}</a>
                </td>
                <td>{run.grade ?? "—"}</td>
                <td>{run.model ?? "—"}</td>
                <td>{run.uiDnaVersion ?? "—"}</td>
                <td>{new Date(run.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
