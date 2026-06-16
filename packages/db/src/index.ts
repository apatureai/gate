export type { SqlExecutor, PgliteLike } from "./executor.js";
export { pgExecutor, pgliteExecutor } from "./executor.js";
export { runMigrations, MIGRATIONS_DIR } from "./migrate.js";

/** Table names owned by Gate's durable product state. */
export const TABLES = [
  "installations",
  "runs",
  "feedback_events",
  "billing_customers",
  "webhook_log",
] as const;

export type TableName = (typeof TABLES)[number];
