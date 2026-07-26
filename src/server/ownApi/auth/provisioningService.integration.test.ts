// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createArgon2PasswordHasher } from "./passwords";
import {
  InitialAdministratorExistsError,
  provisionInitialAdministrator,
} from "./provisioningService";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("one-time initial administrator provisioning", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const passwords = createArgon2PasswordHasher();

  beforeAll(async () => {
    await pool.query("DROP TABLE IF EXISTS native_sessions CASCADE");
    await pool.query("DROP TABLE IF EXISTS native_users CASCADE");
    await pool.query("DROP TABLE IF EXISTS seyirlik_migrations CASCADE");
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE native_sessions, native_users CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates the first administrator with a normalized username and Argon2id hash", async () => {
    const password = "correct horse battery staple";
    const administrator = await provisionInitialAdministrator({
      pool,
      passwords,
      idFactory: randomUUID,
      username: "  FIRST.ADMIN ",
      displayName: "First Administrator",
      password,
    });

    expect(administrator).toEqual({
      id: expect.any(String),
      username: "first.admin",
      displayName: "First Administrator",
      isAdministrator: true,
    });

    const stored = await pool.query<{
      password_hash: string;
      is_administrator: boolean;
    }>(
      "SELECT password_hash, is_administrator FROM native_users WHERE id = $1",
      [administrator.id],
    );
    expect(stored.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.rows[0]?.password_hash).not.toContain(password);
    expect(stored.rows[0]?.is_administrator).toBe(true);
  });

  it("refuses duplicate initialization without creating another user", async () => {
    const input = {
      pool,
      passwords,
      username: "first-admin",
      displayName: "First Administrator",
      password: "correct horse battery staple",
    };
    await provisionInitialAdministrator(input);

    await expect(
      provisionInitialAdministrator({
        ...input,
        username: "second-admin",
        displayName: "Second Administrator",
      }),
    ).rejects.toBeInstanceOf(InitialAdministratorExistsError);

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM native_users",
    );
    expect(count.rows[0]?.count).toBe("1");
  });
});
