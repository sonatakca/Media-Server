import { describe, expect, it } from "vitest";
import {
  deriveVaultKey,
  parseSessionMaterial,
  seal,
  unseal,
} from "./providerSessionVault";

const SECRET = "a".repeat(40);
const material = {
  cookie: "cf_clearance=abc; sid=1",
  userAgent: "Mozilla/5.0",
};

describe("provider session sealing", () => {
  it("round-trips, and never stores the cookie in the clear", () => {
    const key = deriveVaultKey(SECRET);
    const sealed = seal(key, "turkcealtyazi", material);
    expect(sealed.includes(Buffer.from("cf_clearance"))).toBe(false);
    expect(unseal(key, "turkcealtyazi", sealed)).toEqual(material);
  });

  it("does not open for another provider, another key, or tampered bytes", () => {
    const key = deriveVaultKey(SECRET);
    const sealed = seal(key, "turkcealtyazi", material);
    expect(unseal(key, "other", sealed)).toBeNull();
    expect(
      unseal(deriveVaultKey("b".repeat(40)), "turkcealtyazi", sealed),
    ).toBeNull();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(unseal(key, "turkcealtyazi", tampered)).toBeNull();
  });

  it("refuses a short secret", () => {
    expect(() => deriveVaultKey("short")).toThrow();
  });
});

describe("pasted session material", () => {
  it("accepts a copied header line, with or without its name", () => {
    expect(
      parseSessionMaterial({
        cookie: "Cookie: cf_clearance=abc; sid=1 ",
        userAgent: "User-Agent: Mozilla/5.0",
      }),
    ).toEqual(material);
  });

  it("refuses anything that could add a header of its own", () => {
    expect(() =>
      parseSessionMaterial({
        cookie: "sid=1\r\nX-Evil: 1",
        userAgent: "Mozilla/5.0",
      }),
    ).toThrow();
    expect(() =>
      parseSessionMaterial({ cookie: "sid=1", userAgent: "Mozilla\n/5.0" }),
    ).toThrow();
  });

  it("refuses something that is not name=value pairs", () => {
    expect(() =>
      parseSessionMaterial({ cookie: "just some text", userAgent: "UA" }),
    ).toThrow();
    expect(() =>
      parseSessionMaterial({ cookie: "a=1", userAgent: "" }),
    ).toThrow();
  });
});
