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

integration("provider-gated native identity runtime", () => {
  const setupPool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 2,
  });

  beforeAll(async () => {
    await setupPool.query("DROP TABLE IF EXISTS native_sessions CASCADE");
    await setupPool.query("DROP TABLE IF EXISTS native_users CASCADE");
    await setupPool.query("DROP TABLE IF EXISTS seyirlik_migrations CASCADE");
  });

  afterAll(async () => {
    await setupPool.end();
  });

  it("keeps Jellyfin as the default without opening a database", async () => {
    await expect(
      createNativeIdentityRuntime({ environment: {} }),
    ).resolves.toBeNull();
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
