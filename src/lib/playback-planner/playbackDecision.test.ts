import { describe, expect, it } from "vitest";
import { decidePlaybackPlan } from "./playbackDecision";
import type {
  ClientCapabilities,
  MediaAnalysis,
  SubtitleStreamAnalysis,
} from "./types";

function buildClient(
  overrides: Partial<ClientCapabilities> = {},
): ClientCapabilities {
  const base: ClientCapabilities = {
    supportsHlsNative: false,
    supportsMediaSource: true,
    directFileContainers: ["mp4", "webm"],
    mseContainers: ["mp4", "webm"],
    video: {
      h264: {
        supported: true,
        supports10Bit: false,
        supportsHdr: false,
        maxWidth: 3840,
        maxHeight: 2160,
      },
      hevc: {
        supported: false,
        supports10Bit: false,
        supportsHdr: false,
      },
      av1: { supported: true, supports10Bit: true, supportsHdr: false },
      vp9: { supported: true, supports10Bit: true, supportsHdr: false },
    },
    audio: {
      aac: { supported: true, maxChannels: 8 },
      mp3: { supported: true, maxChannels: 2 },
      opus: { supported: true, maxChannels: 8 },
      ac3: { supported: false },
      eac3: { supported: false },
      flac: { supported: false },
    },
    subtitles: {
      srtExternal: false,
      webvttExternal: true,
      assExternal: false,
      imageBasedExternal: false,
    },
    testedAt: "2026-01-01T00:00:00.000Z",
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

function buildMedia(overrides: Partial<MediaAnalysis> = {}): MediaAnalysis {
  const extension = overrides.container?.extension ?? "mp4";

  return {
    mediaId: "media-1",
    filePath: `/media/example.${extension}`,
    container: {
      formatName:
        extension === "mkv" ? "matroska,webm" : "mov,mp4,m4a,3gp,3g2,mj2",
      extension,
      isBrowserDirectPlayableContainer:
        extension === "mp4" || extension === "webm",
      ...overrides.container,
    },
    durationSeconds: 120,
    overallBitrate: 8_000_000,
    videoStreams: [
      {
        index: 0,
        codecName: "h264",
        profile: "High",
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
        isDefault: true,
      },
    ],
    subtitleStreams: [],
    analysedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function pgsSubtitle(index = 2): SubtitleStreamAnalysis {
  return {
    index,
    codecName: "hdmv_pgs_subtitle",
    language: "eng",
    isImageBased: true,
  };
}

function reasonCodes(media: MediaAnalysis, client: ClientCapabilities) {
  return decidePlaybackPlan({ media, client }).reasons.map(
    (reason) => reason.code,
  );
}

describe("decidePlaybackPlan", () => {
  it("direct plays MP4 with H264 and AAC", () => {
    const plan = decidePlaybackPlan({
      media: buildMedia(),
      client: buildClient(),
    });

    expect(plan.mode).toBe("direct-play");
    expect(plan.requiresFfmpeg).toBe(false);
    expect(plan.video.action).toBe("copy");
    expect(plan.audio.action).toBe("copy");
    expect(plan.subtitles.action).toBe("none");
    expect(plan.reasons.map((item) => item.code)).toContain(
      "direct_play_supported",
    );
  });

  it("remuxes MKV with H264 and AAC", () => {
    const plan = decidePlaybackPlan({
      media: buildMedia({
        container: {
          formatName: "matroska,webm",
          extension: "mkv",
          isBrowserDirectPlayableContainer: false,
        },
      }),
      client: buildClient(),
    });

    expect(plan.mode).toBe("remux");
    expect(plan.requiresFfmpeg).toBe(true);
    expect(plan.video.action).toBe("copy");
    expect(plan.audio.action).toBe("copy");
    expect(plan.reasons.map((item) => item.code)).toContain(
      "container_unsupported",
    );
  });

  it("transcodes only audio for MKV HEVC when client supports HEVC but not DTS", () => {
    const plan = decidePlaybackPlan({
      media: buildMedia({
        container: {
          formatName: "matroska,webm",
          extension: "mkv",
          isBrowserDirectPlayableContainer: false,
        },
        videoStreams: [
          {
            index: 0,
            codecName: "hevc",
            profile: "Main 10",
            width: 3840,
            height: 2160,
            bitDepth: 10,
          },
        ],
        audioStreams: [
          {
            index: 1,
            codecName: "dts",
            channels: 6,
            isDefault: true,
          },
        ],
      }),
      client: buildClient({
        video: {
          hevc: {
            supported: true,
            supports10Bit: true,
            supportsHdr: false,
            maxWidth: 3840,
            maxHeight: 2160,
          },
        },
      }),
    });

    expect(plan.mode).toBe("audio-transcode");
    expect(plan.video.action).toBe("copy");
    expect(plan.audio.action).toBe("transcode");
    expect(plan.audio.outputCodec).toBe("aac");
    expect(plan.subtitles.action).toBe("none");
    expect(plan.reasons.map((item) => item.code)).toContain(
      "audio_codec_unsupported",
    );
  });

  it("video-transcodes MKV HEVC when HEVC is unsupported", () => {
    const plan = decidePlaybackPlan({
      media: buildMedia({
        container: {
          formatName: "matroska,webm",
          extension: "mkv",
          isBrowserDirectPlayableContainer: false,
        },
        videoStreams: [
          {
            index: 0,
            codecName: "hevc",
            profile: "Main",
            width: 1920,
            height: 1080,
            bitDepth: 8,
          },
        ],
      }),
      client: buildClient(),
    });

    expect(plan.mode).toBe("video-transcode");
    expect(plan.video.action).toBe("transcode");
    expect(plan.reasons.map((item) => item.code)).toContain(
      "video_codec_unsupported",
    );
  });

  it("does not burn unselected PGS subtitles", () => {
    const plan = decidePlaybackPlan({
      media: buildMedia({
        container: {
          formatName: "matroska,webm",
          extension: "mkv",
          isBrowserDirectPlayableContainer: false,
        },
        subtitleStreams: [pgsSubtitle()],
      }),
      client: buildClient(),
    });

    expect(plan.mode).toBe("remux");
    expect(plan.subtitles.action).toBe("none");
    expect(plan.reasons.map((item) => item.code)).not.toContain(
      "subtitle_burn_required",
    );
  });

  it("burns selected PGS subtitles", () => {
    const media = buildMedia({
      container: {
        formatName: "matroska,webm",
        extension: "mkv",
        isBrowserDirectPlayableContainer: false,
      },
      subtitleStreams: [pgsSubtitle()],
    });
    const plan = decidePlaybackPlan({
      media,
      client: buildClient(),
      selectedSubtitleStreamIndex: 2,
    });

    expect(plan.mode).toBe("subtitle-burn");
    expect(plan.video.action).toBe("transcode");
    expect(plan.subtitles.action).toBe("burn");
    expect(plan.reasons.map((item) => item.code)).toContain(
      "subtitle_burn_required",
    );
  });

  it("video-transcodes HEVC Main10 when client lacks 10-bit HEVC support", () => {
    const plan = decidePlaybackPlan({
      media: buildMedia({
        videoStreams: [
          {
            index: 0,
            codecName: "hevc",
            profile: "Main 10",
            width: 1920,
            height: 1080,
            bitDepth: 10,
          },
        ],
      }),
      client: buildClient({
        video: {
          hevc: {
            supported: true,
            supports10Bit: false,
            supportsHdr: false,
          },
        },
      }),
    });

    expect(plan.mode).toBe("video-transcode");
    expect(plan.reasons.map((item) => item.code)).toContain(
      "video_bit_depth_unsupported",
    );
  });

  it("video-transcodes HDR when client lacks HDR support", () => {
    const plan = decidePlaybackPlan({
      media: buildMedia({
        videoStreams: [
          {
            index: 0,
            codecName: "hevc",
            profile: "Main 10",
            width: 1920,
            height: 1080,
            bitDepth: 10,
            isHdr: true,
          },
        ],
      }),
      client: buildClient({
        video: {
          hevc: {
            supported: true,
            supports10Bit: true,
            supportsHdr: false,
          },
        },
      }),
    });

    expect(plan.mode).toBe("video-transcode");
    expect(plan.reasons.map((item) => item.code)).toContain(
      "hdr_tonemap_required",
    );
  });

  it("keeps video copied when only audio is unsupported", () => {
    const plan = decidePlaybackPlan({
      media: buildMedia({
        audioStreams: [
          {
            index: 1,
            codecName: "truehd",
            channels: 8,
            isDefault: true,
          },
        ],
      }),
      client: buildClient(),
    });

    expect(plan.mode).toBe("audio-transcode");
    expect(plan.video.action).toBe("copy");
    expect(plan.audio.action).toBe("transcode");
    expect(plan.reasons.map((item) => item.code)).toEqual([
      "audio_codec_unsupported",
    ]);
  });

  it("remuxes when only the container is unsupported", () => {
    const media = buildMedia({
      container: {
        formatName: "matroska,webm",
        extension: "mkv",
        isBrowserDirectPlayableContainer: false,
      },
    });
    const client = buildClient();
    const plan = decidePlaybackPlan({ media, client });

    expect(plan.mode).toBe("remux");
    expect(plan.video.action).toBe("copy");
    expect(plan.audio.action).toBe("copy");
    expect(reasonCodes(media, client)).toContain("container_unsupported");
  });

  it("direct plays broad formats for a native libmpv client", () => {
    const plan = decidePlaybackPlan({
      media: buildMedia({
        container: {
          formatName: "matroska,webm",
          extension: "mkv",
          isBrowserDirectPlayableContainer: false,
        },
        videoStreams: [
          {
            index: 0,
            codecName: "hevc",
            profile: "Main 10",
            width: 3840,
            height: 2160,
            bitDepth: 10,
            isHdr: true,
          },
        ],
        audioStreams: [
          {
            index: 1,
            codecName: "dts",
            channels: 8,
            isDefault: true,
          },
        ],
        subtitleStreams: [pgsSubtitle()],
      }),
      client: buildClient({
        playbackEngine: "native",
        nativePlayer: {
          engine: "libmpv",
          version: "test",
          supportedContainers: "*",
          supportedVideoCodecs: "*",
          supportedAudioCodecs: "*",
          hardwareDecoding: true,
          supports10BitVideo: true,
          supportsHdr: true,
          supportsDolbyVisionBaseLayer: true,
          maxWidth: 7680,
          maxHeight: 4320,
          maxAudioChannels: 16,
          subtitles: {
            text: true,
            ass: true,
            imageBased: true,
          },
        },
      }),
      selectedSubtitleStreamIndex: 2,
    });

    expect(plan.mode).toBe("direct-play");
    expect(plan.requiresFfmpeg).toBe(false);
    expect(plan.video.action).toBe("copy");
    expect(plan.audio.action).toBe("copy");
    expect(plan.subtitles.action).toBe("external");
  });

  it("tone maps Dolby Vision when native base-layer fallback is unavailable", () => {
    const plan = decidePlaybackPlan({
      media: buildMedia({
        videoStreams: [
          {
            index: 0,
            codecName: "hevc",
            profile: "Main 10",
            width: 3840,
            height: 2160,
            bitDepth: 10,
            isHdr: true,
            hasDolbyVision: true,
          },
        ],
      }),
      client: buildClient({
        playbackEngine: "native",
        nativePlayer: {
          engine: "libmpv",
          supportedContainers: "*",
          supportedVideoCodecs: "*",
          supportedAudioCodecs: "*",
          hardwareDecoding: true,
          supports10BitVideo: true,
          supportsHdr: true,
          supportsDolbyVisionBaseLayer: false,
          subtitles: {
            text: true,
            ass: true,
            imageBased: true,
          },
        },
      }),
    });

    expect(plan.mode).toBe("video-transcode");
    expect(plan.reasons.map((item) => item.code)).toContain(
      "hdr_tonemap_required",
    );
  });
});
