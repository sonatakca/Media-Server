// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createBackupRepository } from "./backupRepository";

/* Requires a disposable database. The schema is dropped. */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("backup history in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const repository = createBackupRepository(pool);

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies migration 025 and records a run", async () => {
    const saved = await repository.record({
      state: "succeeded",
      destinationClass: "local-protected",
      dumpPresent: true,
      configPresent: true,
      secretsPresent: true,
      dumpBytes: 143311,
      schemaVersion: "025_backup_history",
      schemaCount: 25,
      verification: "verified",
      verifiedTables: 40,
      liveTables: 40,
      finishedAtMs: Date.now(),
    });
    expect(saved).toMatchObject({
      state: "succeeded",
      verification: "verified",
      dumpBytes: 143311,
      schemaVersion: "025_backup_history",
    });
  });

  it("returns the newest run, and the newest that was verified", async () => {
    await repository.record({
      state: "failed",
      destinationClass: "local-protected",
      dumpPresent: false,
      configPresent: false,
      secretsPresent: false,
      verification: "unverified",
      failureClass: "pg_dump-failed",
      startedAtMs: Date.now() + 1000,
    });

    const latest = await repository.latest();
    expect(latest?.state).toBe("failed");

    // The failed run is newer; the verified one is still the last real proof.
    const verified = await repository.latestVerified();
    expect(verified?.verification).toBe("verified");
    expect(verified?.id).not.toBe(latest?.id);
  });

  it("stores a dump size larger than a 32-bit integer", async () => {
    const huge = 5_000_000_000;
    const saved = await repository.record({
      state: "succeeded",
      destinationClass: "local-protected",
      dumpPresent: true,
      configPresent: true,
      secretsPresent: true,
      dumpBytes: huge,
      verification: "unverified",
    });
    expect(saved.dumpBytes).toBe(huge);
  });

  it("holds no secret, path or command in any column", async () => {
    /*
     * The table records evidence, not how the backup was taken. A password in
     * a history row would outlive every rotation.
     */
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'backup_runs'`,
    );
    const names = columns.rows.map((row) => row.column_name).join(" ");
    expect(names).not.toMatch(/password|secret_value|command|path/);
  });

  it("lists history newest first", async () => {
    const rows = await repository.list();
    const times = rows.map((row) => row.startedAtMs);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
