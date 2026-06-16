import { Pool } from "pg";
import { pgExecutor } from "../executor.js";
import { runMigrations } from "../migrate.js";

/**
 * Deploy/CI entrypoint: applies pending migrations against `DATABASE_URL`.
 * Wired as the Fly release command in #32 so migrations run automatically on
 * every deploy.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  try {
    const applied = await runMigrations(pgExecutor(pool));
    console.log(applied.length > 0 ? `Applied: ${applied.join(", ")}` : "No pending migrations");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
