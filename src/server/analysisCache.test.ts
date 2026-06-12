// @vitest-environment node
import { describe, expect, it } from "vitest";
import { InMemoryAnalysisCache } from "./analysisCache";
import type { ResolvedMedia } from "./mediaRegistry";
import type { MediaAnalysis } from "../lib/playback-planner/types";

function media(overrides: Partial<ResolvedMedia> = {}): ResolvedMedia {
  return {
    mediaId: "movie.mp4",
    filePath: "/media/movie.mp4",
    size: 10,
    mtimeMs: 100,
    ...overrides,
  };
}

function analysis(mediaId = "movie.mp4"): MediaAnalysis {
  return {
    mediaId,
    filePath: `/media/${mediaId}`,
    container: {
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      extension: "mp4",
      isBrowserDirectPlayableContainer: true,
    },
    durationSeconds: 10,
    videoStreams: [
      {
        index: 0,
        codecName: "h264",
        width: 1920,
        height: 1080,
        bitDepth: 8,
      },
    ],
    audioStreams: [
      {
        index: 1,
        codecName: "aac",
        channels: 2,
      },
    ],
    subtitleStreams: [],
    analysedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("InMemoryAnalysisCache", () => {
  it("returns a cache hit for unchanged file identity", async () => {
    let calls = 0;
    const cache = new InMemoryAnalysisCache(async () => {
      calls += 1;
      return analysis();
    });

    const first = await cache.getOrAnalyse(media());
    const second = await cache.getOrAnalyse(media());

    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  it("re-analyses after size or mtime changes", async () => {
    let calls = 0;
    const cache = new InMemoryAnalysisCache(async (_filePath, mediaId) => {
      calls += 1;
      return {
        ...analysis(mediaId),
        durationSeconds: calls,
      };
    });

    const first = await cache.getOrAnalyse(media());
    const second = await cache.getOrAnalyse(media({ size: 11 }));
    const third = await cache.getOrAnalyse(media({ size: 11, mtimeMs: 101 }));

    expect(first.durationSeconds).toBe(1);
    expect(second.durationSeconds).toBe(2);
    expect(third.durationSeconds).toBe(3);
    expect(calls).toBe(3);
  });

  it("shares one in-flight analysis for concurrent cache misses", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = new InMemoryAnalysisCache(async () => {
      calls += 1;
      await gate;
      return analysis();
    });

    const first = cache.getOrAnalyse(media());
    const second = cache.getOrAnalyse(media());

    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      analysis(),
      analysis(),
    ]);
    expect(calls).toBe(1);
  });

  it("does not permanently cache failed analyses", async () => {
    let calls = 0;
    const cache = new InMemoryAnalysisCache(async () => {
      calls += 1;

      if (calls === 1) {
        throw new Error("ffprobe failed");
      }

      return analysis();
    });

    await expect(cache.getOrAnalyse(media())).rejects.toThrow("ffprobe failed");
    await expect(cache.getOrAnalyse(media())).resolves.toMatchObject({
      mediaId: "movie.mp4",
    });
    expect(calls).toBe(2);
  });
});
