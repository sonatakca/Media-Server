import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyseRenditionLibrary, findRootsInsideMediaRoot } from "./analysis";
import type { RenditionMediaProbe } from "./probe";

describe("rendition library analysis", () => {
  it("isolates corrupt files, ignores Books, and reports deterministic missing work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-analysis-"));
    const paths = {
      mediaRoot: path.join(root, "media"),
      renditionRoot: path.join(root, "media", ".seyirlik", "renditions"),
      workRoot: path.join(root, "media", ".seyirlik", "work"),
      stateRoot: path.join(root, "media", ".seyirlik", "state"),
      logsRoot: path.join(root, "media", ".seyirlik", "logs"),
    };
    await mkdir(path.join(paths.mediaRoot, "Movies"), { recursive: true });
    await mkdir(path.join(paths.mediaRoot, "Series"), { recursive: true });
    await mkdir(path.join(paths.mediaRoot, "Books"), { recursive: true });
    await writeFile(path.join(paths.mediaRoot, "Movies", "Film.mkv"), "movie");
    await writeFile(
      path.join(paths.mediaRoot, "Series", "Broken.mkv"),
      "broken",
    );
    await writeFile(path.join(paths.mediaRoot, "Books", "Bonus.mp4"), "book");

    const movieProbe: RenditionMediaProbe = {
      durationSeconds: 60,
      overallBitrate: 15_000_000,
      video: {
        streamIndex: 0,
        codec: "hevc",
        width: 3840,
        height: 2160,
        rotation: 0,
        frameRate: 24,
        isHdr: false,
      },
      audioTracks: [
        {
          streamIndex: 1,
          codec: "aac",
          channels: 2,
          isDefault: true,
          isCommentary: false,
          isVisualImpaired: false,
          isOriginal: false,
        },
      ],
      subtitleTracks: [],
      chapters: [],
    };

    const report = await analyseRenditionLibrary({
      paths,
      driveSpace: { totalBytes: 1_000_000_000_000, freeBytes: 900_000_000_000 },
      probe: async (filePath) => {
        if (filePath.endsWith("Broken.mkv")) throw new Error("corrupt input");
        return movieProbe;
      },
      saveReport: false,
    });

    expect(report.summary.totalEligibleVideoCount).toBe(2);
    expect(report.summary.movieCount).toBe(1);
    expect(report.summary.episodeCount).toBe(1);
    expect(report.summary.probeFailureCount).toBe(1);
    expect(report.summary.source2160pCount).toBe(1);
    expect(report.summary.missingByHeight).toEqual({
      "480": 1,
      "720": 1,
      "1080": 1,
    });
    expect(
      report.items.find((item) => item.relativePath.endsWith("Broken.mkv"))
        ?.status,
    ).toBe("failed");
    expect(
      report.items
        .find((item) => item.relativePath.endsWith("Film.mkv"))
        ?.jobs.map((job) => job.qualityHeight),
    ).toEqual([144, 240, 360, 480, 720, 1080, 2160]);
    expect(report.storage.completePlanFits).toBe(true);
  });

  it("flags generated output that library automation could reach", () => {
    const inside = {
      mediaRoot: path.join("D:", "media"),
      renditionRoot: path.join("D:", "media", ".seyirlik", "renditions"),
      workRoot: path.join("D:", "media", ".seyirlik", "work"),
      stateRoot: path.join("D:", "media", ".seyirlik", "state"),
      logsRoot: path.join("D:", "media", ".seyirlik", "logs"),
    };
    expect(findRootsInsideMediaRoot(inside)).toHaveLength(2);

    const outside = {
      ...inside,
      renditionRoot: path.join("D:", "seyirlik", "renditions"),
      workRoot: path.join("D:", "seyirlik", "work"),
    };
    expect(findRootsInsideMediaRoot(outside)).toEqual([]);
  });
});
