import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import { runMigrations } from "../src/server/ownApi/database/migrationRunner";

async function main(): Promise<void> {
  const config = parseDatabaseConfig({
    ...process.env,
  });

  if (!config) {
    throw new Error("Native database configuration is unavailable.");
  }

  const pool = createDatabasePool(config);
  try {
    const result = await runMigrations(pool);
    console.info(
      result.applied.length
        ? `Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`
        : "Database migrations are already current.",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Native database migration failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
