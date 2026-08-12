// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createNativeIdentityRuntime } from "./nativeIdentityRuntime";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const secrets = {
  SEYIRLIK_SESSION_HASH_SECRET:
    "test-session-hash-secret-at-least-thirty-two-bytes",
  SEYIRLIK_CSRF_SECRET: "test-csrf-secret-at-least-thirty-two-bytes",
};

integration("native identity runtime", () => {
  const setupPool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 2,
  });

  beforeAll(async () => {
    // Whole schema, not a list of tables: leaving the catalogue tables from
    // later migrations behind made the migration run below fail on a table
    // that already existed.
    await setupPool.query("DROP SCHEMA public CASCADE");
    await setupPool.query("CREATE SCHEMA public");
  });

  afterAll(async () => {
    await setupPool.end();
  });

  it("refuses to start without a database rather than degrading", async () => {
    // There is no other identity source to fall back to, so an unconfigured
    // runtime has to fail loudly instead of returning a disabled one.
    await expect(
      createNativeIdentityRuntime({ environment: {} }),
    ).rejects.toThrow();
  });

  it("fails startup when native identity migrations are not current", async () => {
    await expect(
      createNativeIdentityRuntime({
        environment: {
          ...secrets,
          DATABASE_URL: databaseUrl,
        },
      }),
    ).rejects.toThrow("Native identity database migrations are not current.");
  });

  it("opens a bounded runtime after migration and reports database readiness", async () => {
    await runMigrations(setupPool);
    const runtime = await createNativeIdentityRuntime({
      environment: {
        ...secrets,
        NODE_ENV: "development",
        DATABASE_URL: databaseUrl,
        SEYIRLIK_DATABASE_POOL_MAX: "3",
      },
    });

    expect(runtime).not.toBeNull();
    await expect(runtime!.databaseCheck()).resolves.toBe("available");
    await runtime!.close();
    await expect(runtime!.databaseCheck()).resolves.toBe("unavailable");
  });
});
