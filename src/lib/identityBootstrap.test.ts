import { describe, expect, it, vi } from "vitest";
import { bootstrapIdentity, parseIdentityProvider } from "./identityBootstrap";

const nativeUser = {
  id: "user-1",
  username: "person",
  displayName: "Person",
  isAdministrator: false,
};

describe("provider-gated identity bootstrap", () => {
  it("keeps Jellyfin as the default provider", () => {
    expect(parseIdentityProvider(undefined)).toBe("jellyfin");
    expect(parseIdentityProvider("")).toBe("jellyfin");
    expect(() => parseIdentityProvider("own-api")).toThrow(
      "VITE_IDENTITY_PROVIDER must be either jellyfin or native.",
    );
  });

  it("does not call the native API in default Jellyfin mode", async () => {
    const getNativeCurrentUser = vi.fn(async () => nativeUser);
    const getJellyfinIdentity = vi.fn(() => ({ authenticated: true }));

    await expect(
      bootstrapIdentity(
        { provider: "jellyfin" },
        { getNativeCurrentUser, getJellyfinIdentity },
      ),
    ).resolves.toEqual({
      provider: "jellyfin",
      status: "authenticated",
      user: null,
    });
    expect(getNativeCurrentUser).not.toHaveBeenCalled();
    expect(getJellyfinIdentity).toHaveBeenCalledTimes(1);
  });

  it("retrieves me only from own API in explicit native mode", async () => {
    const getNativeCurrentUser = vi.fn(async () => nativeUser);
    const getJellyfinIdentity = vi.fn(() => ({ authenticated: true }));

    await expect(
      bootstrapIdentity(
        { provider: "native" },
        { getNativeCurrentUser, getJellyfinIdentity },
      ),
    ).resolves.toEqual({
      provider: "native",
      status: "authenticated",
      user: nativeUser,
    });
    expect(getNativeCurrentUser).toHaveBeenCalledTimes(1);
    expect(getJellyfinIdentity).not.toHaveBeenCalled();
  });

  it("never falls back to Jellyfin when native identity fails", async () => {
    const failure = new Error("native unavailable");
    const getNativeCurrentUser = vi.fn(async () => {
      throw failure;
    });
    const getJellyfinIdentity = vi.fn(() => ({ authenticated: true }));

    await expect(
      bootstrapIdentity(
        { provider: "native" },
        { getNativeCurrentUser, getJellyfinIdentity },
      ),
    ).rejects.toBe(failure);
    expect(getJellyfinIdentity).not.toHaveBeenCalled();
  });
});
