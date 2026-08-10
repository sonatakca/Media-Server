// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseNativeAuthConfig } from "./authConfig";

describe("native authentication runtime configuration", () => {
  it("requires its secrets by default, since native identity is the only mode", () => {
    expect(() => parseNativeAuthConfig({})).toThrow(
      "SEYIRLIK_SESSION_HASH_SECRET is required",
    );
  });

  it("fails clearly when native secrets are missing or weak", () => {
    expect(() =>
      parseNativeAuthConfig({ SEYIRLIK_IDENTITY_PROVIDER: "native" }),
    ).toThrow("SEYIRLIK_SESSION_HASH_SECRET is required");
    expect(() =>
      parseNativeAuthConfig({
        SEYIRLIK_IDENTITY_PROVIDER: "native",
        SEYIRLIK_SESSION_HASH_SECRET: "short",
        SEYIRLIK_CSRF_SECRET: "also-short",
      }),
    ).toThrow("SEYIRLIK_SESSION_HASH_SECRET must be at least 32 bytes");
  });

  it("requires independent session and CSRF secrets", () => {
    const reusedSecret = "one-secret-must-not-protect-two-different-purposes";

    expect(() =>
      parseNativeAuthConfig({
        SEYIRLIK_IDENTITY_PROVIDER: "native",
        SEYIRLIK_SESSION_HASH_SECRET: reusedSecret,
        SEYIRLIK_CSRF_SECRET: reusedSecret,
      }),
    ).toThrow("must be different");
  });

  it("requires secure cookies in production and explicit development cookies otherwise", () => {
    const base = {
      SEYIRLIK_IDENTITY_PROVIDER: "native",
      SEYIRLIK_SESSION_HASH_SECRET:
        "session-hash-secret-with-at-least-thirty-two-bytes",
      SEYIRLIK_CSRF_SECRET: "csrf-secret-with-at-least-thirty-two-bytes",
    };

    expect(
      parseNativeAuthConfig({ ...base, NODE_ENV: "production" }),
    ).toMatchObject({
      secureCookies: true,
      sessionCookieName: "__Secure-seyirlik_session",
      csrfCookieName: "__Secure-seyirlik_csrf",
    });
    expect(
      parseNativeAuthConfig({ ...base, NODE_ENV: "development" }),
    ).toMatchObject({
      secureCookies: false,
      sessionCookieName: "seyirlik_session",
      csrfCookieName: "seyirlik_csrf",
    });
  });
});
