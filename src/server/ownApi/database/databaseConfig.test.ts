// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseDatabaseConfig, parseIdentityProvider } from "./databaseConfig";

describe("native identity database configuration", () => {
  it("keeps Jellyfin as the default identity provider", () => {
    expect(parseIdentityProvider(undefined)).toBe("jellyfin");
    expect(parseIdentityProvider("  ")).toBe("jellyfin");
  });

  it("requires an explicit native identity provider selection", () => {
    expect(parseIdentityProvider("native")).toBe("native");
    expect(() => parseIdentityProvider("own-api")).toThrow(
      "SEYIRLIK_IDENTITY_PROVIDER must be either jellyfin or native.",
    );
  });

  it("requires PostgreSQL only when native identity is enabled", () => {
    expect(
      parseDatabaseConfig({
        NODE_ENV: "production",
        SEYIRLIK_IDENTITY_PROVIDER: "jellyfin",
      }),
    ).toBeNull();

    expect(() =>
      parseDatabaseConfig({
        NODE_ENV: "production",
        SEYIRLIK_IDENTITY_PROVIDER: "native",
      }),
    ).toThrow("DATABASE_URL is required when native identity is enabled.");
  });

  it("accepts only PostgreSQL URLs and bounded pool sizes", () => {
    expect(() =>
      parseDatabaseConfig({
        SEYIRLIK_IDENTITY_PROVIDER: "native",
        DATABASE_URL: "mysql://database.invalid/seyirlik",
      }),
    ).toThrow("DATABASE_URL must use PostgreSQL.");

    expect(() =>
      parseDatabaseConfig({
        SEYIRLIK_IDENTITY_PROVIDER: "native",
        DATABASE_URL: "postgresql://database.invalid/seyirlik",
        SEYIRLIK_DATABASE_POOL_MAX: "101",
      }),
    ).toThrow(
      "SEYIRLIK_DATABASE_POOL_MAX must be an integer between 1 and 20.",
    );

    expect(
      parseDatabaseConfig({
        SEYIRLIK_IDENTITY_PROVIDER: "native",
        DATABASE_URL: "postgresql://database.invalid/seyirlik",
        SEYIRLIK_DATABASE_POOL_MAX: "7",
      }),
    ).toMatchObject({ maxConnections: 7 });
  });
});
