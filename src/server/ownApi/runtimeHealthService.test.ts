// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createRuntimeHealthService } from "./runtimeHealthService";

describe("runtime health service", () => {
  it("reports ready only when every mandatory dependency is usable", async () => {
    const commandProbe = vi.fn(async () => true);
    const readableDirectoryProbe = vi.fn(async () => true);
    const writableDirectoryProbe = vi.fn(async () => true);
    const service = createRuntimeHealthService({
      ffmpegPath: "/configured/bin/ffmpeg",
      ffprobePath: "/configured/bin/ffprobe",
      mediaStoragePath: "/configured/media",
      generatedStoragePath: "/configured/generated",
      databaseCheck: async () => "available",
      jobsCheck: async () => "available",
      commandProbe,
      readableDirectoryProbe,
      writableDirectoryProbe,
    });

    await expect(service.getStatus()).resolves.toEqual({
      status: "ok",
      alive: true,
      ready: true,
      checks: {
        database: "available",
        jobs: "available",
        ffmpeg: "available",
        ffprobe: "available",
        mediaStorage: "available",
        generatedStorage: "writable",
      },
    });
    expect(commandProbe).toHaveBeenNthCalledWith(1, "/configured/bin/ffmpeg");
    expect(commandProbe).toHaveBeenNthCalledWith(2, "/configured/bin/ffprobe");
    expect(readableDirectoryProbe).toHaveBeenCalledWith("/configured/media");
    expect(writableDirectoryProbe).toHaveBeenCalledWith(
      "/configured/generated",
    );
  });

  it("fails closed without exposing probe errors", async () => {
    const service = createRuntimeHealthService({
      mediaStoragePath: "/configured/media",
      generatedStoragePath: "/configured/generated",
      commandProbe: async (command) => {
        if (command === "ffmpeg") {
          throw new Error("private command error");
        }

        return false;
      },
      readableDirectoryProbe: async () => {
        throw new Error("/private/media/path");
      },
      writableDirectoryProbe: async () => false,
    });

    await expect(service.getStatus()).resolves.toEqual({
      status: "ok",
      alive: true,
      ready: false,
      checks: {
        database: "unavailable",
        jobs: "disabled",
        ffmpeg: "unavailable",
        ffprobe: "unavailable",
        mediaStorage: "unavailable",
        generatedStorage: "unavailable",
      },
    });
  });

  it("fails closed within a bounded time when dependency probes hang", async () => {
    const never = () => new Promise<never>(() => undefined);
    const service = createRuntimeHealthService({
      mediaStoragePath: "/media",
      generatedStoragePath: "/generated",
      databaseCheck: never,
      jobsCheck: never,
      commandProbe: never,
      readableDirectoryProbe: never,
      writableDirectoryProbe: never,
      probeTimeoutMs: 10,
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      ready: false,
      checks: {
        database: "unavailable",
        jobs: "unavailable",
        ffmpeg: "unavailable",
        ffprobe: "unavailable",
        mediaStorage: "unavailable",
        generatedStorage: "unavailable",
      },
    });
  });

  it("caches and coalesces public dependency probes to prevent process storms", async () => {
    let now = 1_000;
    const commandProbe = vi.fn(async () => true);
    const readableDirectoryProbe = vi.fn(async () => true);
    const writableDirectoryProbe = vi.fn(async () => true);
    const service = createRuntimeHealthService({
      mediaStoragePath: "/media",
      generatedStoragePath: "/generated",
      commandProbe,
      readableDirectoryProbe,
      writableDirectoryProbe,
      cacheTtlMs: 10_000,
      now: () => now,
    });

    await Promise.all([
      service.getStatus(),
      service.getStatus(),
      service.getStatus(),
    ]);
    await service.getStatus();

    expect(commandProbe).toHaveBeenCalledTimes(2);
    expect(readableDirectoryProbe).toHaveBeenCalledTimes(1);
    expect(writableDirectoryProbe).toHaveBeenCalledTimes(1);

    now += 10_001;
    await service.getStatus();

    expect(commandProbe).toHaveBeenCalledTimes(4);
    expect(readableDirectoryProbe).toHaveBeenCalledTimes(2);
    expect(writableDirectoryProbe).toHaveBeenCalledTimes(2);
  });
});
