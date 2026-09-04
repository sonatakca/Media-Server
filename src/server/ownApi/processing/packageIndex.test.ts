/**
 * The index exists so a page that polls once a second never reads the media
 * volume. These tests are about exactly that: what it touches, how often, and
 * what it says while it has not looked yet.
 */

import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import type { TitlePackageManifest } from "../../../renditions/adaptive/publishTitle";
import {
  createPackageIndex,
  packageStateOf,
  summarisePackage,
  type PackageIndexTarget,
} from "./packageIndex";

function manifest(
  rungs: number[],
  overrides: Partial<TitlePackageManifest> = {},
): TitlePackageManifest {
  return {
    schemaVersion: 1,
    profileVersion: ADAPTIVE_PROFILE_VERSION,
    sourceFingerprint: "fp",
    createdAt: new Date().toISOString(),
    sourceDurationSeconds: 3000,
    masterPlaylistPath: ".seyirlik/master.m3u8",
    video: rungs.map((height) => ({
      id: `${height}p`,
      qualityHeight: height,
      hdr: "sdr",
      mediaPath: `video/${height}p.mp4`,
      playlistPath: `.seyirlik/video/${height}p.m3u8`,
      fileSizeBytes: 1,
    })),
    audio: [{ id: "a" }],
    subtitle: [],
    storage: { totalBytes: 100 },
    ...overrides,
  } as unknown as TitlePackageManifest;
}

function target(id: string, kind = "episode"): PackageIndexTarget {
  return {
    mediaFileId: id,
    sourcePath: `/media/Series/Show/Season 1/Show - ${id}.mp4`,
    kind,
    fingerprint: "fp",
  };
}

describe("summarising one package", () => {
  it("calls a whole ladder complete", () => {
    const summary = summarisePackage(
      manifest([1080, 720, 480, 360, 240, 144]),
      "fp",
    );
    expect(summary?.complete).toBe(true);
    expect(summary?.current).toBe(true);
    expect(packageStateOf(summary)).toBe("complete");
  });

  it("calls a short ladder partial", () => {
    const summary = summarisePackage(manifest([1080, 720]), "fp");
    expect(summary?.complete).toBe(false);
    expect(packageStateOf(summary)).toBe("partial");
  });

  it("calls a package from an older profile stale", () => {
    const summary = summarisePackage(
      manifest([1080, 720, 480, 360, 240, 144], { profileVersion: "old" }),
      "fp",
    );
    expect(packageStateOf(summary)).toBe("stale");
  });

  /*
   * A finished title whose source has been deleted still has no fingerprint to
   * match against. It must read as complete, not as stale — the source being
   * gone is the intended end state, not a fault.
   */
  it("still calls a whole ladder complete when the source is gone", () => {
    const summary = summarisePackage(
      manifest([1080, 720, 480, 360, 240, 144]),
      null,
    );
    expect(summary?.sourceMatches).toBe(false);
    expect(packageStateOf(summary)).toBe("complete");
  });

  it("says nothing about a title with no manifest", () => {
    expect(summarisePackage(null, "fp")).toBeNull();
    expect(packageStateOf(null)).toBe("none");
  });
});

describe("the index", () => {
  it("answers unknown before it has looked, and never waits", () => {
    const index = createPackageIndex({
      readManifest: async () => manifest([1080]),
      resolveRoot: async (entry) => path.dirname(entry.sourcePath),
    });
    expect(index.get("nothing-yet").state).toBe("unknown");
  });

  it("fills in what it was asked to track, in the background", async () => {
    const readManifest = vi.fn(async () => manifest([1080, 720]));
    const index = createPackageIndex({
      readManifest,
      resolveRoot: async (entry) => path.dirname(entry.sourcePath),
    });

    index.track([target("a"), target("b")]);
    await index.settle();

    expect(readManifest).toHaveBeenCalledTimes(2);
    expect(index.get("a").state).toBe("partial");
    expect(index.get("b").state).toBe("partial");
  });

  /*
   * The whole point. A page polling once a second must not turn into a read
   * per title per second aimed at a spinning disk.
   */
  it("reads each title once per TTL, however often it is asked", async () => {
    let now = 1_000;
    const readManifest = vi.fn(async () => manifest([1080]));
    const index = createPackageIndex({
      ttlMs: 30_000,
      readManifest,
      resolveRoot: async (entry) => path.dirname(entry.sourcePath),
      now: () => now,
    });

    const titles = Array.from({ length: 86 }, (_, i) => target(`e${i}`));
    for (let poll = 0; poll < 20; poll += 1) {
      index.track(titles);
      await index.settle();
      now += 1_000;
    }

    expect(readManifest).toHaveBeenCalledTimes(86);

    // Past the TTL, they are read again — once.
    now += 40_000;
    index.track(titles);
    await index.settle();
    expect(readManifest).toHaveBeenCalledTimes(172);
  });

  it("never runs more reads at once than it was allowed", async () => {
    let inFlight = 0;
    let peak = 0;
    const index = createPackageIndex({
      concurrency: 3,
      readManifest: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return manifest([1080]);
      },
      resolveRoot: async (entry) => path.dirname(entry.sourcePath),
    });

    index.track(Array.from({ length: 40 }, (_, i) => target(`e${i}`)));
    await index.settle();
    expect(peak).toBeLessThanOrEqual(3);
  });

  /*
   * An unreadable volume is not evidence that a library has been emptied. The
   * entry must stay as it was rather than being overwritten with "none".
   */
  it("keeps what it knew when a read throws", async () => {
    let fail = false;
    const index = createPackageIndex({
      ttlMs: 0,
      readManifest: async () => {
        if (fail) throw new Error("EIO");
        return manifest([1080, 720, 480, 360, 240, 144]);
      },
      resolveRoot: async (entry) => path.dirname(entry.sourcePath),
    });

    index.track([target("a")]);
    await index.settle();
    expect(index.get("a").state).toBe("complete");

    fail = true;
    index.track([target("a")]);
    await index.settle();
    expect(index.get("a").state).toBe("complete");
  });

  it("re-reads a title on demand when a job has just published", async () => {
    let rungs = [1080];
    const index = createPackageIndex({
      readManifest: async () => manifest(rungs),
      resolveRoot: async (entry) => path.dirname(entry.sourcePath),
    });

    index.track([target("a")]);
    await index.settle();
    expect(index.get("a").summary?.rungs).toEqual([1080]);

    rungs = [1080, 720, 480, 360, 240, 144];
    const refreshed = await index.refresh(target("a"));
    expect(refreshed.state).toBe("complete");
    expect(index.get("a").state).toBe("complete");
  });

  it("forgets a title when told to, so the next read is fresh", async () => {
    const readManifest = vi.fn(async () => manifest([1080]));
    const index = createPackageIndex({
      readManifest,
      resolveRoot: async (entry) => path.dirname(entry.sourcePath),
    });

    index.track([target("a")]);
    await index.settle();
    index.invalidate("a");
    expect(index.get("a").state).toBe("unknown");

    index.track([target("a")]);
    await index.settle();
    expect(readManifest).toHaveBeenCalledTimes(2);
  });
});
