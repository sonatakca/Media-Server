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

/**
 * The health endpoint is polled continuously — by Vite in development, by the
 * app on every reconnect — and its cache expires every ten seconds. Against a
 * volume that has stopped answering, each expiry used to launch a fresh `stat`,
 * and each of those held a libuv worker thread for as long as the volume stayed
 * dead. The pool has four.
 */
describe("probing storage that has stopped answering", () => {
  it("never launches a second probe while the first is outstanding", async () => {
    let started = 0;
    let checkedAt = 0;
    const service = createRuntimeHealthService({
      mediaStoragePath: "/Volumes/Expansion/media",
      generatedStoragePath: "/tmp/generated",
      cacheTtlMs: 10,
      probeTimeoutMs: 1,
      now: () => checkedAt,
      commandProbe: async () => true,
      writableDirectoryProbe: async () => true,
      readableDirectoryProbe: () => {
        started += 1;
        // Blocked in the kernel; nothing resolves it.
        return new Promise<boolean>(() => undefined);
      },
    });

    for (let poll = 0; poll < 5; poll += 1) {
      checkedAt += 1_000;
      const status = await service.getStatus();
      // The answer is the timeout fallback, which is the truthful one.
      expect(status.checks.mediaStorage).toBe("unavailable");
    }

    expect(started).toBe(1);
  });

  it("probes again once the outstanding attempt finally settles", async () => {
    let started = 0;
    let checkedAt = 0;
    let mounted = false;
    const service = createRuntimeHealthService({
      mediaStoragePath: "/Volumes/Expansion/media",
      generatedStoragePath: "/tmp/generated",
      cacheTtlMs: 10,
      probeTimeoutMs: 1,
      now: () => checkedAt,
      commandProbe: async () => true,
      writableDirectoryProbe: async () => true,
      readableDirectoryProbe: async () => {
        started += 1;
        return mounted;
      },
    });

    checkedAt += 1_000;
    expect((await service.getStatus()).checks.mediaStorage).toBe("unavailable");

    mounted = true;
    checkedAt += 1_000;
    expect((await service.getStatus()).checks.mediaStorage).toBe("available");
    expect(started).toBe(2);
  });
});
