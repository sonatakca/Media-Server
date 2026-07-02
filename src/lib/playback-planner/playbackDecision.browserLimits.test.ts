import { describe, expect, it } from "vitest";
import { decidePlaybackPlan } from "./playbackDecision";
import type { ClientCapabilities, MediaAnalysis } from "./types";

function createBrowserClient(
  overrides: Partial<ClientCapabilities> = {},
): ClientCapabilities {
  const base: ClientCapabilities = {
    deviceId: "test-browser",
    userAgent: "Vitest browser",
    platform: "test",
    playbackEngine: "browser",
    supportsHlsNative: false,
    supportsMediaSource: true,
    supportsManagedMediaSource: false,
    directFileContainers: ["mp4", "m4v", "mov", "webm"],
    mseContainers: ["mp4", "webm"],
    video: {
      h264: {
        supported: true,
        smooth: true,
        powerEfficient: true,
      },
    },
    audio: {
      aac: {
        supported: true,
      },
    },
    subtitles: {
      srtExternal: false,
      webvttExternal: true,
      assExternal: false,
      imageBasedExternal: false,
    },
    testedAt: new Date(0).toISOString(),
  };

  return {
    ...base,
    ...overrides,
    video: {
      ...base.video,
      ...overrides.video,
    },
    audio: {
      ...base.audio,
      ...overrides.audio,
    },
    subtitles: {
      ...base.subtitles,
      ...overrides.subtitles,
    },
  };
}

function createH264AacMp4(
  overrides: Partial<MediaAnalysis> = {},
): MediaAnalysis {
  const base: MediaAnalysis = {
    mediaId: "test-h264-aac-mp4",
    filePath: "D:/media/test.mp4",
    container: {
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      extension: "mp4",
      isBrowserDirectPlayableContainer: true,
    },
    durationSeconds: 7_200,
    overallBitrate: 60_000_000,
    videoStreams: [
      {
        index: 0,
        codecName: "h264",
        profile: "High",
        level: 51,
        width: 3840,
        height: 2160,
        framerate: 30,
        bitrate: 58_000_000,
        pixFmt: "yuv420p",
        bitDepth: 8,
        isHdr: false,
        hasDolbyVision: false,
      },
    ],
    audioStreams: [
      {
        index: 1,
        codecName: "aac",
        channels: 2,
        channelLayout: "stereo",
        bitrate: 192_000,
        sampleRate: 48_000,
        isDefault: true,
      },
    ],
    subtitleStreams: [],
    analysedAt: new Date(0).toISOString(),
  };

  return {
    ...base,
    ...overrides,
    container: {
      ...base.container,
      ...overrides.container,
    },
    videoStreams: overrides.videoStreams ?? base.videoStreams,
    audioStreams: overrides.audioStreams ?? base.audioStreams,
    subtitleStreams: overrides.subtitleStreams ?? base.subtitleStreams,
  };
}

describe("browser playback capability limits", () => {
  it("does not treat browser probe bitrate and resolution values as hard limits", () => {
    const media = createH264AacMp4();

    const client = createBrowserClient({
      video: {
        h264: {
          supported: true,
          smooth: true,
          powerEfficient: true,

          // These represent the largest successful synthetic probe.
          // They must not become strict browser playback limits.
          maxBitrate: 35_000_000,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFramerate: 30,
        },
      },
    });

    const plan = decidePlaybackPlan({
      media,
      client,
    });

    expect(plan.mode).toBe("direct-play");
    expect(plan.requiresFfmpeg).toBe(false);
    expect(plan.delivery.type).toBe("file");

    expect(
      plan.reasons.some(
        (entry) =>
          entry.code === "bitrate_too_high" ||
          entry.code === "resolution_too_high",
      ),
    ).toBe(false);
  });

  it("does not force transcoding when browser HDR and 10-bit support are unknown", () => {
    const media = createH264AacMp4({
      videoStreams: [
        {
          index: 0,
          codecName: "h264",
          profile: "High 10",
          level: 51,
          width: 3840,
          height: 2160,
          framerate: 23.976,
          bitrate: 20_000_000,
          pixFmt: "yuv420p10le",
          bitDepth: 10,
          isHdr: true,
          hasDolbyVision: false,
        },
      ],
    });

    const client = createBrowserClient({
      video: {
        h264: {
          supported: true,
          smooth: undefined,
          powerEfficient: undefined,
          supports10Bit: undefined,
          supportsHdr: undefined,
        },
      },
    });

    const result = decidePlaybackPlan({
      media,
      client,
    });

    expect(result.mode).toBe("direct-play");
    expect(result.requiresFfmpeg).toBe(false);

    expect(
      result.reasons.some(
        (entry) =>
          entry.code === "video_profile_unsupported" ||
          entry.code === "video_bit_depth_unsupported" ||
          entry.code === "hdr_tonemap_required",
      ),
    ).toBe(false);
  });

  it("still respects an explicit client-wide bitrate limit", () => {
    const media = createH264AacMp4();

    const client = createBrowserClient({
      maxBitrate: 35_000_000,
    });

    const plan = decidePlaybackPlan({
      media,
      client,
    });

    expect(plan.mode).toBe("video-transcode");
    expect(plan.requiresFfmpeg).toBe(true);

    expect(
      plan.reasons.some((entry) => entry.code === "bitrate_too_high"),
    ).toBe(true);
  });

  it("still respects an explicit forced quality bitrate limit", () => {
    const media = createH264AacMp4();
    const client = createBrowserClient();

    const plan = decidePlaybackPlan({
      media,
      client,
      forceQualityLimit: {
        maxBitrate: 20_000_000,
      },
    });

    expect(plan.mode).toBe("video-transcode");
    expect(plan.requiresFfmpeg).toBe(true);

    expect(
      plan.reasons.some((entry) => entry.code === "bitrate_too_high"),
    ).toBe(true);
  });

  it("still respects an explicit forced resolution limit", () => {
    const media = createH264AacMp4();
    const client = createBrowserClient();

    const plan = decidePlaybackPlan({
      media,
      client,
      forceQualityLimit: {
        maxWidth: 1920,
        maxHeight: 1080,
      },
    });

    expect(plan.mode).toBe("video-transcode");
    expect(plan.requiresFfmpeg).toBe(true);

    expect(
      plan.reasons.some((entry) => entry.code === "resolution_too_high"),
    ).toBe(true);
  });

  it("uses declared native-player codec limits as hard limits", () => {
    const media = createH264AacMp4();

    const client = createBrowserClient({
      playbackEngine: "native",
      nativePlayer: {
        engine: "libmpv",
        supportedContainers: ["mp4"],
        supportedVideoCodecs: ["h264"],
        supportedAudioCodecs: ["aac"],
        hardwareDecoding: true,
        supports10BitVideo: false,
        supportsHdr: false,
        supportsDolbyVisionBaseLayer: false,
        maxWidth: 1920,
        maxHeight: 1080,
        maxBitrate: 35_000_000,
        maxAudioChannels: 2,
        subtitles: {
          text: true,
          ass: true,
          imageBased: true,
        },
      },
    });

    const plan = decidePlaybackPlan({
      media,
      client,
    });

    expect(plan.mode).toBe("video-transcode");
    expect(plan.requiresFfmpeg).toBe(true);

    expect(
      plan.reasons.some(
        (entry) =>
          entry.code === "bitrate_too_high" ||
          entry.code === "resolution_too_high",
      ),
    ).toBe(true);
  });
});
