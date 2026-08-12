// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createUserRepository } from "../users/userRepository";
import { createSessionRepository } from "./sessionRepository";
import {
  NativeAuthError,
  createNativeAuthService,
  hashSessionToken,
} from "./authService";
import { createArgon2PasswordHasher } from "./passwords";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("durable native authentication", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 6,
  });
  const users = createUserRepository(pool);
  const sessions = createSessionRepository(pool);
  const passwords = createArgon2PasswordHasher();
  const sessionHashSecret = "test-session-hash-secret-at-least-32-bytes";
  let auth: Awaited<ReturnType<typeof createNativeAuthService>>;
  let userId: string;

  beforeAll(async () => {
    // Whole schema, not a list of tables: leaving the catalogue tables from
    // later migrations behind made runMigrations fail on an existing table.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    auth = await createNativeAuthService({
      users,
      sessions,
      passwords,
      sessionHashSecret,
      absoluteSessionTtlMs: 60_000,
      idleSessionTtlMs: 30_000,
    });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE native_sessions, native_users CASCADE");
    userId = randomUUID();
    await users.create({
      id: userId,
      normalizedUsername: "person",
      displayName: "Person",
      passwordHash: await passwords.hash("correct horse battery staple"),
      isAdministrator: true,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("authenticates correct credentials without exposing password hashes", async () => {
    const result = await auth.login({
      username: "  PERSON ",
      password: "correct horse battery staple",
      deviceDescription: "Integration test",
    });

    expect(result.user).toEqual({
      id: userId,
      username: "person",
      displayName: "Person",
      isAdministrator: true,
    });
    expect(JSON.stringify(result)).not.toContain("$argon2id$");

    const row = await pool.query<{ token_hash: Buffer }>(
      "SELECT token_hash FROM native_sessions WHERE id = $1",
      [result.sessionId],
    );
    expect(row.rows[0]?.token_hash).toEqual(
      hashSessionToken(result.token, sessionHashSecret),
    );
    expect(row.rows[0]?.token_hash.toString("utf8")).not.toBe(result.token);
  });

  it("returns the same generic failure for unknown, incorrect, and disabled users", async () => {
    const attempt = (username: string, password: string) =>
      auth.login({ username, password });

    await expect(
      attempt("missing", "incorrect password"),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", statusCode: 401 });
    await expect(attempt("person", "incorrect password")).rejects.toMatchObject(
      { code: "INVALID_CREDENTIALS", statusCode: 401 },
    );
    await pool.query(
      "UPDATE native_users SET is_disabled = true WHERE id = $1",
      [userId],
    );
    await expect(
      attempt("person", "correct horse battery staple"),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", statusCode: 401 });
  });

  it("rejects expired, revoked, and disabled-user sessions", async () => {
    const expired = await auth.login({
      username: "person",
      password: "correct horse battery staple",
    });
    await pool.query(
      `UPDATE native_sessions
       SET absolute_expires_at = now() - interval '1 second',
           idle_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [expired.sessionId],
    );
    await expect(auth.getCurrentSession(expired.token)).rejects.toBeInstanceOf(
      NativeAuthError,
    );

    const revoked = await auth.login({
      username: "person",
      password: "correct horse battery staple",
    });
    await auth.logout(revoked.token);
    await expect(auth.getCurrentSession(revoked.token)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });

    const disabled = await auth.login({
      username: "person",
      password: "correct horse battery staple",
    });
    await pool.query(
      "UPDATE native_users SET is_disabled = true WHERE id = $1",
      [userId],
    );
    await expect(auth.getCurrentSession(disabled.token)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("rotates refresh tokens atomically and revokes the family on reuse", async () => {
    const login = await auth.login({
      username: "person",
      password: "correct horse battery staple",
    });
    const refreshed = await auth.refresh(login.token);

    expect(refreshed.token).not.toBe(login.token);
    await expect(auth.getCurrentSession(login.token)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await expect(auth.refresh(login.token)).rejects.toMatchObject({
      code: "SESSION_TOKEN_REUSED",
    });
    await expect(auth.getCurrentSession(refreshed.token)).rejects.toMatchObject(
      {
        code: "AUTH_REQUIRED",
      },
    );
  });

  it("handles concurrent refresh deterministically without restoring a revoked family", async () => {
    const login = await auth.login({
      username: "person",
      password: "correct horse battery staple",
    });
    const outcomes = await Promise.allSettled([
      auth.refresh(login.token),
      auth.refresh(login.token),
    ]);
    const fulfilled = outcomes.filter(
      (
        outcome,
      ): outcome is PromiseFulfilledResult<
        Awaited<ReturnType<typeof auth.refresh>>
      > => outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "SESSION_TOKEN_REUSED" });
    await expect(
      auth.getCurrentSession(fulfilled[0]!.value.token),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("revokes all sessions and cleans expired rows", async () => {
    const first = await auth.login({
      username: "person",
      password: "correct horse battery staple",
    });
    const second = await auth.login({
      username: "person",
      password: "correct horse battery staple",
    });

    await expect(auth.logoutAll(first.token)).resolves.toBeUndefined();
    await expect(auth.getCurrentSession(first.token)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await expect(auth.getCurrentSession(second.token)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });

    await pool.query(
      `UPDATE native_sessions
       SET absolute_expires_at = now() - interval '1 second',
           idle_expires_at = now() - interval '1 second'`,
    );
    await expect(auth.cleanupExpiredSessions()).resolves.toBeGreaterThan(0);
  });
});
