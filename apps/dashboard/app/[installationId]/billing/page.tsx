import { computeMonthlyTotalCents, createSqlBillingStore } from "@gate/dashboard";
import { getQuery } from "@/lib/db";
import { requireInstallation } from "@/lib/session";

/** Billing summary for the installation (plan/status + an est. monthly total). */
export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ installationId: string }>;
  searchParams: Promise<{ seats?: string }>;
}) {
  const { installationId } = await params;
  await requireInstallation(Number(installationId));
  const { seats } = await searchParams;

  const billing = await createSqlBillingStore(getQuery()).get(installationId);
  const seatCount = Number(seats ?? "0");
  const monthlyCents = computeMonthlyTotalCents(Number.isFinite(seatCount) ? seatCount : 0);

  return (
    <section>
      <h1>Billing</h1>
      <ul>
        <li>Plan: {billing?.plan ?? "free"}</li>
        <li>Status: {billing?.status ?? "active"}</li>
      </ul>
      <h2>Seat estimate</h2>
      <form method="get" style={{ display: "flex", gap: 8 }}>
        <input name="seats" type="number" min={0} defaultValue={seatCount} style={{ padding: 6 }} />
        <button type="submit">Estimate</button>
      </form>
      <p>
        {seatCount} seat(s): <strong>${(monthlyCents / 100).toFixed(2)}</strong>/month.
      </p>
    </section>
  );
}
