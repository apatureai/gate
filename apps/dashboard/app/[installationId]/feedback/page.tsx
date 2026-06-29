import { computeFeedbackStats, feedbackTrend, loadFeedbackEvents } from "@gate/dashboard";
import { withTenantQuery } from "@/lib/db";
import { requireInstallation } from "@/lib/session";

/** Per-repo feedback stats + acceptance trend, via the core (RLS-scoped). */
export default async function FeedbackPage({
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
    return <p>Select a repository from the installation page to see feedback stats.</p>;
  }

  const events = await withTenantQuery(installationId, (query) => loadFeedbackEvents(query, { owner, name }));
  const stats = computeFeedbackStats(events);
  const trend = feedbackTrend(events);

  return (
    <section>
      <h1>
        Feedback — {owner}/{name}
      </h1>
      <ul>
        <li>Accepted (positive): {stats.positive}</li>
        <li>Dismissed (negative): {stats.negative}</li>
        <li>Neutral: {stats.neutral}</li>
        <li>Total: {stats.total}</li>
        <li>Acceptance rate: {(stats.acceptanceRate * 100).toFixed(0)}%</li>
      </ul>
      <h2>Acceptance trend</h2>
      {trend.length === 0 ? (
        <p>No feedback yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th>Day</th>
              <th>Accepted</th>
              <th>Dismissed</th>
              <th>Neutral</th>
              <th>Rate</th>
            </tr>
          </thead>
          <tbody>
            {trend.map((p) => (
              <tr key={p.bucket}>
                <td>{p.bucket}</td>
                <td>{p.positive}</td>
                <td>{p.negative}</td>
                <td>{p.neutral}</td>
                <td>{(p.acceptanceRate * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
