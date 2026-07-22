// @vitest-environment node
import type { IncomingMessage } from "node:http";
import type { DecodedIdToken } from "firebase-admin/auth";
import { describe, expect, it, vi } from "vitest";
import { createFirebaseAdminAuthorizer } from "./firebaseAdminAuth";

function requestWithToken(token?: string): IncomingMessage {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as IncomingMessage;
}

function decodedToken(overrides: Partial<DecodedIdToken> = {}): DecodedIdToken {
  return {
    aud: "project-id",
    auth_time: 1,
    exp: 2,
    firebase: {
      identities: {},
      sign_in_provider: "google.com",
    },
    iat: 1,
    iss: "https://securetoken.google.com/project-id",
    sub: "admin-uid",
    uid: "admin-uid",
    email: "sonatakcaa@gmail.com",
    email_verified: true,
    ...overrides,
  };
}

describe("Firebase administrator authorization", () => {
  it("requires a bearer token", async () => {
    const authorizer = createFirebaseAdminAuthorizer({
      projectId: "project-id",
      verifyIdToken: vi.fn(),
    });

    await expect(authorizer(requestWithToken())).resolves.toMatchObject({
      authorized: false,
      statusCode: 401,
      code: "ADMIN_AUTH_REQUIRED",
    });
  });

  it("rejects invalid tokens", async () => {
    const authorizer = createFirebaseAdminAuthorizer({
      projectId: "project-id",
      verifyIdToken: vi.fn().mockRejectedValue(new Error("invalid")),
    });

    await expect(
      authorizer(requestWithToken("invalid")),
    ).resolves.toMatchObject({
      authorized: false,
      statusCode: 401,
      code: "ADMIN_AUTH_INVALID",
    });
  });

  it.each([
    decodedToken({ email: "someone@example.com" }),
    decodedToken({ email_verified: false }),
    decodedToken({
      firebase: { identities: {}, sign_in_provider: "password" },
    }),
  ])(
    "rejects a token that is not the configured Google account",
    async (token) => {
      const authorizer = createFirebaseAdminAuthorizer({
        projectId: "project-id",
        verifyIdToken: vi.fn().mockResolvedValue(token),
      });

      await expect(
        authorizer(requestWithToken("token")),
      ).resolves.toMatchObject({
        authorized: false,
        statusCode: 403,
        code: "ADMIN_AUTH_FORBIDDEN",
      });
    },
  );

  it("accepts the verified configured Google account", async () => {
    const authorizer = createFirebaseAdminAuthorizer({
      projectId: "project-id",
      verifyIdToken: vi.fn().mockResolvedValue(decodedToken()),
    });

    await expect(authorizer(requestWithToken("token"))).resolves.toEqual({
      authorized: true,
      uid: "admin-uid",
      email: "sonatakcaa@gmail.com",
    });
  });
});
