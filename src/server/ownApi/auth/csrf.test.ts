// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCsrfToken, verifyCsrfToken } from "./csrf";

const secret = "test-csrf-secret-at-least-thirty-two-bytes";
const firstSession = createHash("sha256").update("session-1").digest();
const secondSession = createHash("sha256").update("session-2").digest();

describe("session-bound signed double-submit CSRF tokens", () => {
  it("accepts only a matching cookie/header token for the issuing session", () => {
    const token = createCsrfToken(firstSession, secret, () =>
      Buffer.alloc(24, 7),
    );

    expect(
      verifyCsrfToken({
        cookieToken: token,
        headerToken: token,
        sessionTokenHash: firstSession,
        secret,
      }),
    ).toBe(true);
    expect(
      verifyCsrfToken({
        cookieToken: token,
        headerToken: token,
        sessionTokenHash: secondSession,
        secret,
      }),
    ).toBe(false);
  });

  it("rejects missing, mismatched, and malformed tokens", () => {
    const token = createCsrfToken(firstSession, secret);

    for (const candidate of [
      { cookieToken: undefined, headerToken: token },
      { cookieToken: token, headerToken: undefined },
      { cookieToken: token, headerToken: `${token}x` },
      { cookieToken: "malformed", headerToken: "malformed" },
    ]) {
      expect(
        verifyCsrfToken({
          ...candidate,
          sessionTokenHash: firstSession,
          secret,
        }),
      ).toBe(false);
    }
  });
});
