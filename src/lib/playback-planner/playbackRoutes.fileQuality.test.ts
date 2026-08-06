import { describe, expect, it, vi } from "vitest";
import type { PlaybackSessionManager } from "./playbackSessionManager";
import { handlePlaybackRequest } from "./playbackRoutes";
import type { ClientCapabilities, MediaAnalysis } from "./types";

const client: ClientCapabilities = {
  supportsHlsNative: false,
  supportsMediaSource: true,
  directFileContainers: ["mp4"],
  mseContainers: ["mp4"],
  video: {
    h264: { supported: true, maxWidth: 1920, maxHeight: 1080 },
    hevc: { supported: false },
    av1: { supported: false },
    vp9: { supported: false },
  },
  audio: {
    aac: { supported: true, maxChannels: 2 },
    mp3: { supported: true, maxChannels: 2 },
    opus: { supported: false },
    ac3: { supported: false },
    eac3: { supported: false },
    flac: { supported: false },
  },
  subtitles: {
    srtExternal: true,
    webvttExternal: true,
    assExternal: false,
    imageBasedExternal: false,
  },
  testedAt: "2026-08-06T00:00:00.000Z",
};

const incompatibleOriginal: MediaAnalysis = {
  mediaId: "media-1",
  filePath: "/media/example.mkv",
  container: {
    formatName: "matroska,webm",
    extension: "mkv",
    isBrowserDirectPlayableContainer: false,
  },
  durationSeconds: 120,
  overallBitrate: 12_000_000,
  videoStreams: [
    {
      index: 0,
      codecName: "hevc",
      width: 3840,
      height: 2160,
      bitDepth: 10,
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
  analysedAt: "2026-08-06T00:00:00.000Z",
};

describe("file-based playback planning", () => {
  it("returns a ready complete MP4 before touching the FFmpeg session manager", async () => {
    const sessionManager = new Proxy(
      {},
      {
        get() {
          throw new Error("FFmpeg session manager must not be touched");
        },
      },
    ) as PlaybackSessionManager;
    const getRenditionManifest = vi.fn().mockResolvedValue({
      mediaId: "media-1",
      qualities: [
        {
          id: "generated-720",
          label: "720p",
          kind: "generated",
          width: 1280,
          height: 720,
          bitrate: 4_000_000,
          fileSize: 60_000_000,
          videoCodec: "h264",
          audioCodec: "aac",
          container: "mp4",
          playbackUrl: "/api/playback/renditions/capability/generated-720.mp4",
          sourceAudioStreamIndex: 1,
        },
      ],
      limitations: {
        generatedAudio: "default-track-only",
        generatedSubtitles: "external-or-original-only",
        switching: "complete-file-rebuffer",
      },
    });

    const plan = await handlePlaybackRequest(
      { mediaId: "media-1", clientCapabilities: client },
      {
        mediaResolver: {
          resolveMedia: vi.fn().mockResolvedValue({
            mediaId: "media-1",
            filePath: "/media/example.mkv",
            size: 1,
            mtimeMs: 1,
          }),
          encodeMediaToken: () => "token",
          decodeMediaToken: () => "media-1",
        },
        mediaStore: {
          getMediaAnalysis: vi.fn().mockResolvedValue(incompatibleOriginal),
        },
        sessionManager,
        getRenditionManifest,
      },
    );

    expect(plan).toMatchObject({
      mode: "direct-play",
      requiresFfmpeg: false,
      delivery: {
        type: "file",
        url: "/api/playback/renditions/capability/generated-720.mp4",
      },
      diagnostics: {
        decision: { ffmpegStarted: false },
      },
    });
    expect(getRenditionManifest).toHaveBeenCalledOnce();
  });
});
