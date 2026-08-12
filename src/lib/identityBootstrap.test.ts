import { describe, expect, it, vi } from "vitest";
import { OwnApiClientError } from "../api/ownApi/client";
import { bootstrapIdentity } from "./identityBootstrap";

const nativeUser = {
  id: "user-1",
  username: "person",
  displayName: "Person",
  isAdministrator: false,
};

function authRequired(): OwnApiClientError {
  return new OwnApiClientError({
    status: 401,
    code: "AUTH_REQUIRED",
    message: "Sign in first.",
  });
}

describe("identity bootstrap", () => {
  it("reports the signed-in user", async () => {
    const getCurrentUser = vi.fn(async () => nativeUser);

    await expect(bootstrapIdentity({ getCurrentUser })).resolves.toEqual({
      status: "authenticated",
      user: nativeUser,
    });
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("treats an unauthenticated response as an answer, not a failure", async () => {
    const getCurrentUser = vi.fn(async () => {
      throw authRequired();
    });

    await expect(bootstrapIdentity({ getCurrentUser })).resolves.toEqual({
      status: "anonymous",
      user: null,
    });
  });

  it("rethrows anything that is not a sign-in prompt", async () => {
    // A server that is down must not be mistaken for a signed-out visitor, or
    // the app would quietly drop the user's session on every outage.
    const failure = new OwnApiClientError({
      status: 503,
      code: "SERVER_NOT_ALIVE",
      message: "Unavailable.",
    });
    const getCurrentUser = vi.fn(async () => {
      throw failure;
    });

    await expect(bootstrapIdentity({ getCurrentUser })).rejects.toBe(failure);
  });

  it("rethrows a 401 that is not AUTH_REQUIRED", async () => {
    const failure = new OwnApiClientError({
      status: 401,
      code: "SESSION_REVOKED",
      message: "Revoked.",
    });
    const getCurrentUser = vi.fn(async () => {
      throw failure;
    });

    await expect(bootstrapIdentity({ getCurrentUser })).rejects.toBe(failure);
  });
});
