import { redactPlaybackUrl } from "../../lib/jellyfinApi";
import type { PlaybackSourceCandidate } from "../../lib/types";
import { getNativeAudioTrackSnapshot } from "./nativeAudioTracks";
import { getStreamsOfType } from "./streamUtils";

function getDebugAudioStreams(source: PlaybackSourceCandidate) {
  return getStreamsOfType(source, "Audio").map((stream) => ({
    Index: stream.Index,
    Language: stream.Language,
    DisplayTitle: stream.DisplayTitle,
    Title: stream.Title,
    Codec: stream.Codec,
    IsDefault: stream.IsDefault,
  }));
}

export function getPlaybackUrlDebugParams(playbackUrl: string) {
  try {
    const url = new URL(playbackUrl);
    const getParam = (name: string) =>
      url.searchParams.get(name) ?? url.searchParams.get(name.toLowerCase());

    return {
      redactedUrl: redactPlaybackUrl(playbackUrl),
      SegmentContainer: getParam("SegmentContainer"),
      TranscodingContainer: getParam("TranscodingContainer"),
      TranscodingProtocol: getParam("TranscodingProtocol"),
      PlaySessionId: getParam("PlaySessionId"),
      MediaSourceId: getParam("MediaSourceId"),
      DeviceId: getParam("DeviceId"),
      VideoCodec: getParam("VideoCodec"),
      AudioCodec: getParam("AudioCodec"),
      AllowVideoStreamCopy: getParam("AllowVideoStreamCopy"),
      AllowAudioStreamCopy: getParam("AllowAudioStreamCopy"),
      EnableAutoStreamCopy: getParam("EnableAutoStreamCopy"),
      EnableAdaptiveBitrateStreaming: getParam(
        "EnableAdaptiveBitrateStreaming",
      ),
      AudioStreamIndex: getParam("AudioStreamIndex"),
      MaxHeight: getParam("MaxHeight"),
      MaxStreamingBitrate: getParam("MaxStreamingBitrate"),
      MinSegments: getParam("MinSegments"),
      SegmentLength: getParam("SegmentLength"),
      BreakOnNonKeyFrames: getParam("BreakOnNonKeyFrames"),
    };
  } catch {
    return {
      redactedUrl: redactPlaybackUrl(playbackUrl),
      SegmentContainer: undefined,
      TranscodingContainer: undefined,
      TranscodingProtocol: undefined,
      PlaySessionId: undefined,
      MediaSourceId: undefined,
      DeviceId: undefined,
      VideoCodec: undefined,
      AudioCodec: undefined,
      AllowVideoStreamCopy: undefined,
      AllowAudioStreamCopy: undefined,
      EnableAutoStreamCopy: undefined,
      EnableAdaptiveBitrateStreaming: undefined,
      AudioStreamIndex: undefined,
      MaxHeight: undefined,
      MaxStreamingBitrate: undefined,
      MinSegments: undefined,
      SegmentLength: undefined,
      BreakOnNonKeyFrames: undefined,
    };
  }
}

export function isMasterHlsPlaybackUrl(playbackUrl: string): boolean {
  try {
    const baseUrl =
      typeof window === "undefined"
        ? "http://localhost"
        : window.location.origin;
    const url = new URL(playbackUrl, baseUrl);

    return url.pathname.toLowerCase().includes("/master.m3u8");
  } catch {
    return playbackUrl.toLowerCase().includes("/master.m3u8");
  }
}

export function logAudioSourceDebug(
  label: string,
  video: HTMLVideoElement,
  source: PlaybackSourceCandidate,
  selectedAudioStreamIndex: number | undefined,
  extra?: Record<string, unknown>,
): void {
  console.info(`[Seyirlik Playback] ${label}`, {
    selectedAudioStreamIndex,
    defaultAudioStreamIndex: source.mediaSource.DefaultAudioStreamIndex,
    jellyfinAudioStreams: getDebugAudioStreams(source),
    nativeAudioTracks: getNativeAudioTrackSnapshot(video),
    activeSource: {
      mode: source.mode,
      isHls: source.isHls,
      hlsKind: source.hlsKind,
      mediaSourceId: source.mediaSourceId,
      url: redactPlaybackUrl(source.url),
      urlParams: getPlaybackUrlDebugParams(source.url),
    },
    ...extra,
  });
}
