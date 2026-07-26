import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Pool } from "pg";

const MIGRATION_FILE_PATTERN = /^\d{3,}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = "7610294835701";
const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

export interface MigrationResult {
  applied: string[];
}

interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
}

async function loadMigrationFiles(
  migrationsDirectory: string,
): Promise<MigrationFile[]> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => MIGRATION_FILE_PATTERN.test(file))
    .sort();

  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(path.join(migrationsDirectory, file), "utf8");
      return {
        version: path.basename(file, ".sql"),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

export async function validateMigrationsCurrent(
  database: Pick<Pool, "query">,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<void> {
  const expected = await loadMigrationFiles(migrationsDirectory);
  let rows: Array<{ version: string; checksum: string }>;
  try {
    const result = await database.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM seyirlik_migrations ORDER BY version",
    );
    rows = result.rows;
  } catch {
    throw new Error("Native identity database migrations are not current.");
  }

  if (
    rows.length !== expected.length ||
    expected.some(
      (migration, index) =>
        rows[index]?.version !== migration.version ||
        rows[index]?.checksum !== migration.checksum,
    )
  ) {
    throw new Error("Native identity database migrations are not current.");
  }
}

export async function runMigrations(
  pool: Pick<Pool, "connect">,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<MigrationResult> {
  const migrations = await loadMigrationFiles(migrationsDirectory);
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS seyirlik_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const { version, sql, checksum } of migrations) {
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM seyirlik_migrations WHERE version = $1",
        [version],
      );

      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`Applied migration ${version} has changed.`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO seyirlik_migrations (version, checksum) VALUES ($1, $2)",
          [version, checksum],
        );
        await client.query("COMMIT");
        applied.push(version);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    return { applied };
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}
