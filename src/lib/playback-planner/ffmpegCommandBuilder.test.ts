// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildFfmpegCommand } from "./ffmpegCommandBuilder";
import type { FfmpegRuntimeProfile } from "./ffmpegRuntime";
import type { MediaAnalysis, PlaybackPlan } from "./types";

function media(overrides: Partial<MediaAnalysis> = {}): MediaAnalysis {
  return {
    mediaId: "movie-1",
    filePath: "/media/movie.mkv",
    container: {
      formatName: "matroska,webm",
      extension: "mkv",
      isBrowserDirectPlayableContainer: false,
    },
    durationSeconds: 60,
    overallBitrate: 12_000_000,
    videoStreams: [
      {
        index: 0,
        codecName: "hevc",
        width: 1920,
        height: 1080,
        bitDepth: 10,
      },
    ],
    audioStreams: [{ index: 1, codecName: "aac", channels: 2 }],
    subtitleStreams: [],
    analysedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function plan(): PlaybackPlan {
  return {
    mode: "video-transcode",
    requiresFfmpeg: true,
    preservesOriginalVideoQuality: false,
    expectedStartup: "slow",
    mediaId: "movie-1",
    selected: { videoStreamIndex: 0, audioStreamIndex: 1 },
    container: { input: "mkv", output: "hls-fmp4", action: "hls" },
    video: {
      inputCodec: "hevc",
      outputCodec: "h264",
      action: "transcode",
    },
    audio: { inputCodec: "aac", action: "copy" },
    subtitles: { action: "none" },
    reasons: [],
    delivery: { type: "hls" },
  };
}

function runtime(
  videoEncoder: FfmpegRuntimeProfile["videoEncoder"],
): FfmpegRuntimeProfile {
  return {
    videoEncoder,
    hardwareAccelerated: videoEncoder !== "libx264",
    softwareThreads: 3,
    availableVideoEncoders: [videoEncoder],
    supportsHdrToneMapping: true,
  };
}

describe("buildFfmpegCommand", () => {
  it("uses a selected hardware encoder", () => {
    const command = buildFfmpegCommand({
      plan: plan(),
      media: media(),
      outputDir: "/tmp/output",
      runtimeProfile: runtime("h264_videotoolbox"),
    });

    expect(command.args).toContain("h264_videotoolbox");
    expect(command.args).toContain("-allow_sw");
    expect(command.args).not.toContain("libx264");
  });

  it("bounds software encoder and filter threads", () => {
    const command = buildFfmpegCommand({
      plan: plan(),
      media: media(),
      outputDir: "/tmp/output",
      runtimeProfile: runtime("libx264"),
    });

    expect(command.args).toEqual(
      expect.arrayContaining([
        "-filter_threads",
        "3",
        "-c:v",
        "libx264",
        "-threads",
        "3",
      ]),
    );
  });

  it("adds HDR tone mapping before H.264 output", () => {
    const command = buildFfmpegCommand({
      plan: plan(),
      media: media({
        videoStreams: [
          {
            index: 0,
            codecName: "hevc",
            width: 3840,
            height: 2160,
            bitDepth: 10,
            isHdr: true,
          },
        ],
      }),
      outputDir: "/tmp/output",
      runtimeProfile: runtime("libx264"),
    });
    const filterIndex = command.args.indexOf("-vf");

    expect(filterIndex).toBeGreaterThan(-1);
    expect(command.args[filterIndex + 1]).toContain("tonemap=hable");
    expect(command.args[filterIndex + 1]).toContain("format=yuv420p");
  });

  it("refuses unsafe HDR conversion when tone-map filters are missing", () => {
    const limitedRuntime = {
      ...runtime("libx264"),
      supportsHdrToneMapping: false,
    };

    expect(() =>
      buildFfmpegCommand({
        plan: plan(),
        media: media({
          videoStreams: [
            {
              index: 0,
              codecName: "hevc",
              width: 3840,
              height: 2160,
              bitDepth: 10,
              isHdr: true,
            },
          ],
        }),
        outputDir: "/tmp/output",
        runtimeProfile: limitedRuntime,
      }),
    ).toThrow("cannot tone-map HDR safely");
  });
});
