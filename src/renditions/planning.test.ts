import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORAGE_SAFETY_MARGIN,
  buildStorageSchedule,
  calculateReserveBytes,
  estimateRenditionBytes,
  getPendingRenditionHeights,
} from "./planning";

describe("rendition storage planning", () => {
  it("uses bitrate, MP4 container overhead and the conservative safety margin", () => {
    const estimate = estimateRenditionBytes({
      durationSeconds: 8,
      videoBitrate: 9_800_000,
      audioBitrate: 200_000,
      overheadRatio: 0.01,
      safetyMarginRatio: DEFAULT_STORAGE_SAFETY_MARGIN,
    });

    expect(estimate.payloadBytes).toBe(10_000_000);
    expect(estimate.withOverheadBytes).toBe(10_100_000);
    expect(estimate.conservativeBytes).toBe(11_615_000);
  });

  it("uses the greater of 25 GB and ten percent of drive capacity", () => {
    const gib = 1024 ** 3;
    expect(calculateReserveBytes(100 * gib)).toBe(25 * gib);
    expect(calculateReserveBytes(1_000 * gib)).toBe(100 * gib);
  });

  it("excludes valid output while including stale and invalid output", () => {
    expect(
      getPendingRenditionHeights(
        [1080, 720, 480],
        new Map([
          [1080, "ready"],
          [720, "stale"],
          [480, "validation-failed"],
        ]),
      ),
    ).toEqual([720, 480]);
  });

  it("prioritises complete deterministic Movie ladders before Series", () => {
    const schedule = buildStorageSchedule({
      driveTotalBytes: 1_000,
      driveFreeBytes: 350,
      reserveBytes: 100,
      items: [
        {
          mediaId: "series-b",
          relativePath: "Series/Zeta/S01E01.mkv",
          library: "Series",
          jobs: [{ qualityHeight: 480, estimatedBytes: 100 }],
        },
        {
          mediaId: "movie-z",
          relativePath: "Movies/Zeta.mkv",
          library: "Movies",
          jobs: [{ qualityHeight: 480, estimatedBytes: 100 }],
        },
        {
          mediaId: "movie-a",
          relativePath: "Movies/Alfa.mkv",
          library: "Movies",
          jobs: [{ qualityHeight: 480, estimatedBytes: 100 }],
        },
      ],
    });

    expect(schedule.selected.map((item) => item.mediaId)).toEqual(["movie-a"]);
    expect(schedule.deferred.map((item) => item.mediaId)).toEqual([
      "movie-z",
      "series-b",
    ]);
    expect(schedule.policy).toBe("complete-title-lowest-first");
    expect(schedule.peakRequiredBytes).toBe(215);
    expect(schedule.expectedRemainingFreeBytes).toBe(235);
    expect(schedule.completePlanFits).toBe(false);
  });

  it("orders rendition jobs lowest first within each title", () => {
    const schedule = buildStorageSchedule({
      driveTotalBytes: 10_000,
      driveFreeBytes: 9_000,
      reserveBytes: 1_000,
      items: [
        {
          mediaId: "movie",
          relativePath: "Movies/Film.mkv",
          library: "Movies",
          jobs: [
            { qualityHeight: 1080, estimatedBytes: 300 },
            { qualityHeight: 480, estimatedBytes: 100 },
            { qualityHeight: 720, estimatedBytes: 200 },
          ],
        },
      ],
    });

    expect(schedule.selected[0]?.jobs.map((job) => job.qualityHeight)).toEqual([
      480, 720, 1080,
    ]);
  });
});
