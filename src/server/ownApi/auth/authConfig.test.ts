// @vitest-environment node
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { parseCookieDomain, parseNativeAuthConfig } from "./authConfig";
import { applicableCookieDomain } from "./authHttpHandler";

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

describe("cookie domain", () => {
  it("is absent unless configured, keeping cookies host-only", () => {
    expect(parseCookieDomain(undefined)).toBeUndefined();
    expect(parseCookieDomain("  ")).toBeUndefined();
  });

  /**
   * Needed when the app and the API sit on different hosts of one registrable
   * domain: the app has to be able to read the CSRF token the API issued.
   */
  it("accepts a parent domain with or without the leading dot", () => {
    expect(parseCookieDomain("seyirlik.org")).toBe("seyirlik.org");
    expect(parseCookieDomain(".seyirlik.org")).toBe("seyirlik.org");
    expect(parseCookieDomain("  .Seyirlik.ORG ")).toBe("seyirlik.org");
  });

  it("refuses a value that would scope the session far too widely", () => {
    // A single label is either a public suffix or meaningless to a browser.
    expect(() => parseCookieDomain("org")).toThrow(/at least two labels/);
    expect(() => parseCookieDomain("localhost")).toThrow(/at least two labels/);
  });

  it("refuses anything that is not a domain", () => {
    expect(() => parseCookieDomain("https://seyirlik.org")).toThrow();
    expect(() => parseCookieDomain("seyirlik.org/path")).toThrow();
    expect(() => parseCookieDomain("seyirlik..org")).toThrow();
  });
});

describe("applicableCookieDomain", () => {
  function request(host: string | undefined): IncomingMessage {
    return {
      headers: host === undefined ? {} : { host },
    } as unknown as IncomingMessage;
  }

  it("uses the configured domain for the domain itself and its subdomains", () => {
    expect(
      applicableCookieDomain(request("seyirlik.org"), "seyirlik.org"),
    ).toBe("seyirlik.org");
    expect(
      applicableCookieDomain(request("www.seyirlik.org"), "seyirlik.org"),
    ).toBe("seyirlik.org");
    expect(
      applicableCookieDomain(request("playback.seyirlik.org:8443"), "seyirlik.org"),
    ).toBe("seyirlik.org");
  });

  it("omits the domain for a host it would not cover", () => {
    // A browser discards a cookie whose Domain the host does not belong to, so
    // sending one here means logging in appears to succeed and then does not.
    // Without the attribute the cookie is scoped to the exact host instead.
    for (const host of [
      "localhost",
      "localhost:5173",
      "192.168.1.108:5173",
      "100.86.155.75:5173",
      "notseyirlik.org",
      "seyirlik.org.evil.test",
    ]) {
      expect(applicableCookieDomain(request(host), "seyirlik.org")).toBeUndefined();
    }
  });

  it("has nothing to apply when no domain is configured", () => {
    expect(
      applicableCookieDomain(request("www.seyirlik.org"), undefined),
    ).toBeUndefined();
    expect(applicableCookieDomain(request(undefined), "seyirlik.org")).toBeUndefined();
  });

  it("matches case-insensitively and tolerates a leading dot", () => {
    expect(
      applicableCookieDomain(request("WWW.Seyirlik.ORG"), ".seyirlik.org"),
    ).toBe(".seyirlik.org");
  });
});
