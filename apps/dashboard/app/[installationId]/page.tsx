/**
 * Installation overview: a small repo picker. The data pages (runs/feedback/…)
 * are scoped by `?owner=&name=` since the core data layer keys on repo
 * owner/name under a tenant-scoped (RLS) query.
 */
export default async function InstallationHome({ params }: { params: Promise<{ installationId: string }> }) {
  const { installationId } = await params;
  return (
    <section>
      <h1>Installation {installationId}</h1>
      <p>Pick a repository to view its reviews, feedback, and config.</p>
      <form action={`/${installationId}/runs`} method="get" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input name="owner" placeholder="owner" required style={{ padding: 6 }} />
        <input name="name" placeholder="repo" required style={{ padding: 6 }} />
        <button type="submit">View runs</button>
      </form>
    </section>
  );
}
