import { describe, expect, it, vi } from "vitest";
import type { OwnApiHealthResponse } from "../api/ownApi/client";
import { checkServerAvailability } from "./serverAvailability";

const health: OwnApiHealthResponse = {
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

describe("server availability", () => {
  it("accepts a server that is alive but not yet ready", async () => {
    // Readiness covers background work such as scanning. The interface is
    // usable long before that finishes, so liveness is the bar for startup.
    const getHealth = vi.fn(async () => health);

    await expect(
      checkServerAvailability({}, { getHealth }),
    ).resolves.toBeUndefined();
    expect(getHealth).toHaveBeenCalledTimes(1);
  });

  it("fails when the server reports it is not alive", async () => {
    const getHealth = vi.fn(async () => ({ ...health, alive: false }));

    await expect(
      checkServerAvailability({}, { getHealth }),
    ).rejects.toMatchObject({ code: "SERVER_NOT_ALIVE" });
  });

  it("passes an abort signal through to the health request", async () => {
    const getHealth = vi.fn(async () => health);
    const controller = new AbortController();

    await checkServerAvailability({ signal: controller.signal }, { getHealth });

    expect(getHealth).toHaveBeenCalledWith({ signal: controller.signal });
  });
});
