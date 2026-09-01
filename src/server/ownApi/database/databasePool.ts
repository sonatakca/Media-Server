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
    // A connection parked in the pool is idle TCP, which a router, a laptop
    // sleeping, or Docker's NAT will silently drop. Keepalives make the socket
    // notice while the pool can still replace it.
    keepAlive: true,
  };

  const pool = new Pool(poolConfig);

  /*
   * PostgreSQL restarting must not take the media server with it.
   *
   * `Pool` is an EventEmitter, and an EventEmitter with no `error` listener
   * rethrows what it is given — out of a timer, from an idle client nobody is
   * awaiting, straight past every `try` in the codebase and into the process.
   * That is the whole of it: a `pg_ctl restart`, a `brew services restart`, or
   * a dropped idle socket ended the server outright, with
   * `terminating connection due to administrator command` as the only notice.
   *
   * The pool itself needs no help recovering — it discards the broken client
   * and dials again on the next query — so this listener exists to say what
   * happened and let the process carry on.
   */
  pool.on("error", (error) => {
    console.error(
      "[Seyirlik] Idle database connection failed; the pool will reconnect:",
      error instanceof Error ? error.message : String(error),
    );
  });

  return pool;
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
