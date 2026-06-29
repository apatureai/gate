import { describe, expect, it } from "vitest";
import { withDashboardTenant, type DashboardTenantRunner, type SqlQuery } from "../src/index.js";

describe("withDashboardTenant", () => {
  it("delegates dashboard reads through the tenant runner", async () => {
    const query: SqlQuery = async () => ({ rows: [{ ok: true }] });
    const calls: Array<string | number> = [];
    const runner: DashboardTenantRunner = {
      async withTenant(installationId, fn) {
        calls.push(installationId);
        return fn(query);
      },
    };

    const rows = await withDashboardTenant(runner, "123", (q) => q("SELECT 1"));

    expect(calls).toEqual(["123"]);
    expect(rows.rows).toEqual([{ ok: true }]);
  });

  it("rejects a missing installation id instead of running unscoped", async () => {
    const runner: DashboardTenantRunner = {
      async withTenant() {
        throw new Error("must not run");
      },
    };

    await expect(withDashboardTenant(runner, "", async () => "unreachable")).rejects.toThrow(/installation id/);
  });
});
