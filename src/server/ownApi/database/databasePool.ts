import { Pool, type PoolConfig } from "pg";
import type { DatabaseConfig } from "./databaseConfig";

export type DatabasePool = Pool;

export function createDatabasePool(config: DatabaseConfig): DatabasePool {
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.maxConnections,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "seyirlik-own-api",
    statement_timeout: 10_000,
    query_timeout: 12_000,
  };

  return new Pool(poolConfig);
}

export async function validateDatabaseConnection(
  pool: Pick<DatabasePool, "query">,
): Promise<void> {
  await pool.query("SELECT 1");
}

export async function validateNativeIdentitySchema(
  pool: Pick<DatabasePool, "query">,
): Promise<void> {
  const result = await pool.query<{
    users_table: string | null;
    sessions_table: string | null;
    migration_applied: boolean;
  }>(
    `SELECT
       to_regclass($1) AS users_table,
       to_regclass($2) AS sessions_table,
       EXISTS (
         SELECT 1 FROM seyirlik_migrations WHERE version = $3
       ) AS migration_applied`,
    ["native_users", "native_sessions", "001_native_identity"],
  );
  const row = result.rows[0];
  if (!row?.users_table || !row.sessions_table || !row.migration_applied) {
    throw new Error("Native identity database migrations are not current.");
  }
}

export async function checkDatabaseReadiness(
  pool: Pick<DatabasePool, "query">,
): Promise<"available" | "unavailable"> {
  try {
    await validateDatabaseConnection(pool);
    return "available";
  } catch {
    return "unavailable";
  }
}
