import { describe, expect, it, vi } from "vitest";
import type { OwnApiHealthResponse } from "../api/ownApi/client";
import {
  checkServerAvailability,
  parseServerBootstrapProvider,
} from "./serverAvailability";

const nativeHealth: OwnApiHealthResponse = {
  status: "ok",
  alive: true,
  ready: false,
  checks: {
    database: "unavailable",
    jobs: "disabled",
    ffmpeg: "available",
    ffprobe: "available",
    mediaStorage: "available",
    generatedStorage: "writable",
  },
};

describe("server availability bootstrap adapter", () => {
  it("defaults to the Jellyfin provider and validates explicit modes", () => {
    expect(parseServerBootstrapProvider(undefined)).toBe("jellyfin");
    expect(parseServerBootstrapProvider("  own-api ")).toBe("own-api");
    expect(parseServerBootstrapProvider("jellyfin")).toBe("jellyfin");
    expect(() => parseServerBootstrapProvider("automatic")).toThrow(
      "VITE_SERVER_BOOTSTRAP_PROVIDER must be either own-api or jellyfin",
    );
  });

  it("uses only native health in own-api mode and accepts not-ready liveness", async () => {
    const getHealth = vi.fn(async () => nativeHealth);
    const testJellyfinConnection = vi.fn();

    await expect(
      checkServerAvailability(
        { provider: "own-api", serverUrl: "https://media.example" },
        { getHealth, testJellyfinConnection },
      ),
    ).resolves.toEqual({ provider: "own-api" });

    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(testJellyfinConnection).not.toHaveBeenCalled();
  });

  it("fails closed without invoking Jellyfin when native liveness is false", async () => {
    const getHealth = vi.fn(async () => ({ ...nativeHealth, alive: false }));
    const testJellyfinConnection = vi.fn();

    await expect(
      checkServerAvailability(
        { provider: "own-api", serverUrl: "https://media.example" },
        { getHealth, testJellyfinConnection },
      ),
    ).rejects.toMatchObject({ code: "SERVER_NOT_ALIVE" });

    expect(testJellyfinConnection).not.toHaveBeenCalled();
  });

  it("preserves the legacy Jellyfin probe in jellyfin mode", async () => {
    const getHealth = vi.fn();
    const testJellyfinConnection = vi.fn(async () => ({ ServerName: "Media" }));

    await expect(
      checkServerAvailability(
        { provider: "jellyfin", serverUrl: "https://media.example" },
        { getHealth, testJellyfinConnection },
      ),
    ).resolves.toEqual({ provider: "jellyfin" });

    expect(testJellyfinConnection).toHaveBeenCalledWith(
      "https://media.example",
    );
    expect(getHealth).not.toHaveBeenCalled();
  });
});
