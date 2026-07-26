// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ARGON2ID_OPTIONS,
  createArgon2PasswordHasher,
  normalizeUsername,
  validatePassword,
  validateUsername,
} from "./passwords";

describe("native password handling", () => {
  it("normalizes usernames with NFKC, trimming, and locale-stable lowercase", () => {
    expect(normalizeUsername("  AdMiN  ")).toBe("admin");
    expect(normalizeUsername("ＳＥＹＩＲＬＩＫ")).toBe("seyirlik");
  });

  it("enforces bounded username and password requirements", () => {
    expect(() => validateUsername("ab")).toThrow();
    expect(() => validateUsername("not allowed")).toThrow();
    expect(validateUsername("person.name-1")).toBe("person.name-1");

    expect(() => validatePassword("short")).toThrow();
    expect(() => validatePassword("🔐".repeat(6))).toThrow();
    expect(() => validatePassword("x".repeat(129))).toThrow();
    expect(validatePassword("🔐".repeat(12))).toBe("🔐".repeat(12));
    expect(validatePassword("correct horse battery staple")).toBe(
      "correct horse battery staple",
    );
  });

  it("stores and verifies intentional Argon2id hashes", async () => {
    const hasher = createArgon2PasswordHasher();
    const password = "correct horse battery staple";
    const hash = await hasher.hash(password);

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).toContain(
      `m=${ARGON2ID_OPTIONS.memoryCost},p=${ARGON2ID_OPTIONS.parallelism},t=${ARGON2ID_OPTIONS.timeCost}`,
    );
    expect(hash).not.toContain(password);
    await expect(hasher.verify(hash, password)).resolves.toBe(true);
    await expect(hasher.verify(hash, "incorrect password")).resolves.toBe(
      false,
    );
  });
});
