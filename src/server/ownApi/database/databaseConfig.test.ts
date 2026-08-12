// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseDatabaseConfig } from "./databaseConfig";

describe("database configuration", () => {
  it("requires PostgreSQL, because there is no other place to keep state", () => {
    expect(() => parseDatabaseConfig({ NODE_ENV: "production" })).toThrow(
      "DATABASE_URL is required.",
    );
  });

  it("rejects a connection URL for anything other than PostgreSQL", () => {
    expect(() =>
      parseDatabaseConfig({
        DATABASE_URL: "mysql://database.invalid/seyirlik",
      }),
    ).toThrow("DATABASE_URL must use PostgreSQL.");

    expect(() => parseDatabaseConfig({ DATABASE_URL: "not a url" })).toThrow(
      "DATABASE_URL must be a valid PostgreSQL connection URL.",
    );
  });

  it("bounds the connection pool", () => {
    expect(() =>
      parseDatabaseConfig({
        DATABASE_URL: "postgresql://database.invalid/seyirlik",
        SEYIRLIK_DATABASE_POOL_MAX: "101",
      }),
    ).toThrow(
      "SEYIRLIK_DATABASE_POOL_MAX must be an integer between 1 and 20.",
    );

    expect(
      parseDatabaseConfig({
        DATABASE_URL: "postgresql://database.invalid/seyirlik",
        SEYIRLIK_DATABASE_POOL_MAX: "7",
      }),
    ).toMatchObject({ maxConnections: 7 });
  });

  it("defaults the pool size when none is configured", () => {
    expect(
      parseDatabaseConfig({
        DATABASE_URL: "postgresql://database.invalid/seyirlik",
      }),
    ).toMatchObject({ maxConnections: 10 });
  });
});
