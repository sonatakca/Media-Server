// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createProviderSessionVault } from "./providerSessionVault";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("provider session vault", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl!,
    maxConnections: 2,
  });
  const vault = () =>
    createProviderSessionVault({
      db: pool,
      secret: "s".repeat(40),
      anonymous: { turkcealtyazi: { userAgent: "Seyirlik/1.0" } },
    });

  beforeAll(async () => {
    // Only ever an explicitly supplied, disposable test database.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("asks anonymously until refused, then waits for a person", async () => {
    const sessions = vault();
    const first = await sessions.manager.acquire("turkcealtyazi");
    expect(first.outcome).toBe("ready");
    if (first.outcome === "ready")
      expect(first.session.revealHeaders()).toEqual({
        "user-agent": "Seyirlik/1.0",
      });
    expect((await sessions.status("turkcealtyazi")).state).toBe("anonymous");

    await sessions.manager.invalidate("turkcealtyazi", "Challenged.");
    expect((await sessions.manager.acquire("turkcealtyazi")).outcome).toBe(
      "needs-authentication",
    );
    expect(await sessions.status("turkcealtyazi")).toMatchObject({
      state: "rejected",
      reason: "Challenged.",
    });
  });

  it("stores only ciphertext, and hands the pasted session back", async () => {
    const sessions = vault();
    await sessions.store("turkcealtyazi", {
      cookie: "cf_clearance=secret-value",
      userAgent: "Mozilla/5.0 Test",
    });
    const raw = await pool.query<{ sealed: Buffer }>(
      "SELECT sealed FROM provider_sessions WHERE provider_id = 'turkcealtyazi'",
    );
    expect(raw.rows[0]!.sealed.includes(Buffer.from("secret-value"))).toBe(
      false,
    );
    const acquired = await sessions.manager.acquire("turkcealtyazi");
    expect(
      acquired.outcome === "ready" && acquired.session.revealHeaders(),
    ).toEqual({
      cookie: "cf_clearance=secret-value",
      "user-agent": "Mozilla/5.0 Test",
    });
    // Unprintable by construction.
    expect(JSON.stringify(acquired)).not.toContain("secret-value");
  });

  it("does not let a refusal of an old session wipe a newer one", async () => {
    const worker = vault();
    const server = vault();
    await server.store("turkcealtyazi", { cookie: "a=old", userAgent: "UA" });
    expect((await worker.manager.acquire("turkcealtyazi")).outcome).toBe(
      "ready",
    );
    // Somebody pastes a fresh session while the worker's request is in flight…
    await new Promise((resolve) => setTimeout(resolve, 5));
    await server.store("turkcealtyazi", { cookie: "a=new", userAgent: "UA" });
    // …and then the worker's old session is refused.
    await worker.manager.invalidate("turkcealtyazi", "Challenged.");
    expect((await server.status("turkcealtyazi")).state).toBe("active");
  });

  it("forgets a session, returning to anonymous", async () => {
    const sessions = vault();
    await sessions.clear("turkcealtyazi");
    expect((await sessions.status("turkcealtyazi")).state).toBe("anonymous");
  });

  it("does not open a session sealed under a different key", async () => {
    await vault().store("turkcealtyazi", { cookie: "a=1", userAgent: "UA" });
    const rotated = createProviderSessionVault({
      db: pool,
      secret: "t".repeat(40),
    });
    expect((await rotated.manager.acquire("turkcealtyazi")).outcome).toBe(
      "needs-authentication",
    );
  });
});
