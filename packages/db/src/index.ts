export type { SqlExecutor, PgliteLike } from "./executor.js";
export { pgExecutor, pgliteExecutor } from "./executor.js";
export { runMigrations, MIGRATIONS_DIR } from "./migrate.js";
export { TENANT_GUC, pgliteTenantRunner, pgTenantRunner } from "./tenant.js";
export type { QueryFn, TenantTxRunner, TenantRunnerOptions } from "./tenant.js";

/** Table names owned by Gate's durable product state. */
export const TABLES = [
  "installations",
  "runs",
  "feedback_events",
  "billing_customers",
  "webhook_log",
  "screenshot_artifacts",
  "feedback_consumed_tokens",
] as const;

export type TableName = (typeof TABLES)[number];
