import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../../i18n/LanguageContext";
import { LANGUAGE_STORAGE_KEY } from "../../i18n/translations";
import type { PlaybackSourceCandidate } from "../../lib/types";
import { PlaybackInfoPanel } from "./PlaybackInfoPanel";

const { getActiveTranscodingReasonsMock } = vi.hoisted(() => ({
  getActiveTranscodingReasonsMock: vi.fn(),
}));

vi.mock("../../lib/mediaApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/mediaApi")>();

  return {
    ...original,
    getActiveTranscodingReasons: getActiveTranscodingReasonsMock,
  };
});

function directPlaySource(): PlaybackSourceCandidate {
  return {
    id: "custom-direct-play-file",
    itemId: "movie-1",
    mediaSourceId: "movie-1",
    mode: "DirectPlay",
    url: "http://backend.test/api/playback/direct/media-token",
    mimeType: "video/mp4",
    isHls: false,
    hlsKind: "direct",
    label: "Direct play",
    reason: "The selected streams are direct-play compatible.",
    transcodeReasons: ["direct_play_supported"],
    priority: 0,
    playbackDiagnostics: {
      clientCapabilities: {
        supportsHlsNative: true,
        supportsMediaSource: true,
        directFileContainers: ["mp4"],
        mseContainers: ["mp4"],
        video: { h264: { supported: true } },
        audio: { aac: { supported: true } },
        subtitles: {
          srtExternal: false,
          webvttExternal: true,
          assExternal: false,
          imageBasedExternal: false,
        },
        testedAt: "2026-01-01T00:00:00.000Z",
      },
      media: {
        mediaId: "movie-1",
        container: {
          formatName: "mp4",
          isBrowserDirectPlayableContainer: true,
        },
        durationSeconds: 120,
        videoStreams: [
          { index: 0, codecName: "h264", width: 1920, height: 1080 },
        ],
        audioStreams: [{ index: 1, codecName: "aac" }],
        subtitleStreams: [],
        analysedAt: "2026-01-01T00:00:00.000Z",
      },
      decision: {
        browserCapabilityMatch: {
          container: true,
          video: true,
          audio: true,
          subtitles: true,
        },
        byteRangeSupported: true,
        directPlaySupported: true,
        ffmpegStarted: false,
        mode: "direct-play",
        source: {
          container: "mp4",
          videoCodec: "h264",
          audioCodec: "aac",
        },
        requiresFfmpeg: false,
        preservesOriginalVideoQuality: true,
        expectedStartup: "instant",
        containerAction: "direct",
        videoAction: "transcode",
        audioAction: "copy",
        subtitleAction: "none",
        selectedVideoStreamIndex: 0,
        selectedAudioStreamIndex: 1,
        reasons: [],
        blockingReasons: [],
      },
    },
    mediaSource: {
      Id: "movie-1",
      Name: "Movie",
      Container: "mp4",
      SupportsDirectPlay: true,
      TranscodingReasons: ["direct_play_supported"],
      MediaStreams: [
        { Index: 0, Type: "Video", Codec: "h264" },
        { Index: 1, Type: "Audio", Codec: "aac" },
      ],
    },
  };
}

beforeEach(() => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "tr");
  getActiveTranscodingReasonsMock.mockReset();
  getActiveTranscodingReasonsMock.mockResolvedValue(["stale_reason"]);
});

describe("PlaybackInfoPanel", () => {
  it("does not label positive direct-play reasons as transcoding", async () => {
    render(
      <LanguageProvider>
        <PlaybackInfoPanel
          source={directPlaySource()}
          videoError={null}
          onClose={vi.fn()}
        />
      </LanguageProvider>,
    );

    expect(screen.queryByText("Dönüştürme nedeni")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Jellyfin şu yüzden dönüştürüyor"),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(getActiveTranscodingReasonsMock).not.toHaveBeenCalled(),
    );
  });
});
