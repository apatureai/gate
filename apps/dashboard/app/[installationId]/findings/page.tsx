import { listRunHistory } from "@gate/dashboard";
import Link from "next/link";
import { getQuery } from "@/lib/db";
import { requireInstallation } from "@/lib/session";

/** Finding browser index: pick a run to see its annotated findings. */
export default async function FindingsIndex({
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
    return <p>Select a repository from the installation page to browse findings.</p>;
  }

  const runs = await listRunHistory(getQuery(), { owner, name });
  const qs = `?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`;

  return (
    <section>
      <h1>
        Findings — {owner}/{name}
      </h1>
      {runs.length === 0 ? (
        <p>No reviews recorded yet.</p>
      ) : (
        <ul>
          {runs.map((run) => (
            <li key={run.id}>
              <Link href={`/${installationId}/findings/${run.id}${qs}`}>
                PR #{run.prNumber} — {run.grade ?? "—"} ({new Date(run.createdAt).toLocaleDateString()})
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
