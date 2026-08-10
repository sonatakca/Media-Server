import { describe, expect, it } from "vitest";
import { toPersistedProbe } from "./probeInventory";
import { classifyProbeFailure } from "./probeService";
import type { MediaAnalysis } from "../../../lib/playback-planner/types";

function analysis(overrides: Partial<MediaAnalysis> = {}): MediaAnalysis {
  return {
    mediaId: "file-1",
    filePath: "/media/Movies/A.mkv",
    container: {
      formatName: "matroska,webm",
      extension: "mkv",
      isBrowserDirectPlayableContainer: false,
    },
    durationSeconds: 7_260.5,
    overallBitrate: 12_000_000,
    videoStreams: [],
    audioStreams: [],
    subtitleStreams: [],
    analysedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("toPersistedProbe", () => {
  it("converts duration to milliseconds and keeps the container extension", () => {
    const probe = toPersistedProbe(analysis());
    expect(probe.durationMs).toBe(7_260_500);
    expect(probe.bitrateBps).toBe(12_000_000);
    expect(probe.container).toBe("mkv");
  });

  it("treats a zero or unknown duration as absent rather than as zero runtime", () => {
    expect(toPersistedProbe(analysis({ durationSeconds: 0 })).durationMs).toBeNull();
    expect(
      toPersistedProbe(analysis({ durationSeconds: Number.NaN })).durationMs,
    ).toBeNull();
  });

  it("marks Dolby Vision and HDR video ranges distinctly", () => {
    const dolbyVision = toPersistedProbe(
      analysis({
        videoStreams: [
          {
            index: 0,
            codecName: "hevc",
            width: 3840,
            height: 2160,
            isHdr: true,
            hasDolbyVision: true,
          },
        ],
      }),
    );
    expect(dolbyVision.streams[0]?.videoRange).toBe("DOVI");

    const hdr = toPersistedProbe(
      analysis({
        videoStreams: [
          { index: 0, codecName: "hevc", width: 3840, height: 2160, isHdr: true },
        ],
      }),
    );
    expect(hdr.streams[0]?.videoRange).toBe("HDR");

    const sdr = toPersistedProbe(
      analysis({
        videoStreams: [
          { index: 0, codecName: "h264", width: 1920, height: 1080 },
        ],
      }),
    );
    expect(sdr.streams[0]?.videoRange).toBe("SDR");
  });

  it("records whether a subtitle stream can be converted to text", () => {
    const probe = toPersistedProbe(
      analysis({
        subtitleStreams: [
          { index: 2, codecName: "subrip", isImageBased: false },
          { index: 3, codecName: "hdmv_pgs_subtitle", isImageBased: true },
        ],
      }),
    );

    expect(probe.streams.map((stream) => stream.isTextSubtitle)).toEqual([
      true,
      false,
    ]);
  });

  it("keeps audio track metadata the picker relies on", () => {
    const probe = toPersistedProbe(
      analysis({
        audioStreams: [
          {
            index: 1,
            codecName: "eac3",
            channels: 6,
            sampleRate: 48_000,
            bitrate: 640_000,
            language: "eng",
            title: "Surround",
            isDefault: true,
          },
        ],
      }),
    );

    expect(probe.streams[0]).toMatchObject({
      kind: "audio",
      codec: "eac3",
      channels: 6,
      sampleRate: 48_000,
      bitrateBps: 640_000,
      language: "eng",
      title: "Surround",
      isDefault: true,
    });
  });

  it("orders streams by index across kinds", () => {
    const probe = toPersistedProbe(
      analysis({
        videoStreams: [{ index: 0, codecName: "h264", width: 1, height: 1 }],
        audioStreams: [{ index: 2, codecName: "aac" }],
        subtitleStreams: [{ index: 1, codecName: "subrip", isImageBased: false }],
      }),
    );

    expect(probe.streams.map((stream) => stream.streamIndex)).toEqual([0, 1, 2]);
  });

  it("renumbers chapters in start order", () => {
    const probe = toPersistedProbe(
      analysis({
        chapters: [
          { startSeconds: 120, endSeconds: 240, title: "Second" },
          { startSeconds: 0, endSeconds: 120, title: "  First  " },
          { startSeconds: 240, endSeconds: 300, title: "   " },
        ],
      }),
    );

    expect(probe.chapters).toEqual([
      { chapterIndex: 0, startMs: 0, name: "First" },
      { chapterIndex: 1, startMs: 120_000, name: "Second" },
      { chapterIndex: 2, startMs: 240_000, name: null },
    ]);
  });
});

describe("classifyProbeFailure", () => {
  it("keeps a recognised reason", () => {
    expect(
      classifyProbeFailure(
        new Error("ffprobe failed with exit code 1: Invalid data found when processing input"),
      ),
    ).toBe("Invalid data found when processing input");
  });

  /**
   * FFmpeg reports "<input path>: <reason>", and library paths contain spaces,
   * so the path cannot be stripped out reliably. Only the recognised reason is
   * kept; everything else is discarded.
   */
  it("does not leak the filesystem path that FFmpeg echoes back", () => {
    const message =
      "ffprobe failed with exit code 1: Yeni Dunya\\Cesur Yeni Dunya.epub: Invalid data found when processing input";

    const classified = classifyProbeFailure(new Error(message));

    expect(classified).toBe("Invalid data found when processing input");
    expect(classified).not.toContain("epub");
    expect(classified).not.toContain("\\");
  });

  it("falls back to a generic message for anything unrecognised", () => {
    expect(
      classifyProbeFailure(new Error("D:/media/Movies/Secret (2024)/x.mkv weird failure")),
    ).toBe("The media file could not be analysed.");
  });
});
