import {
  getDefaultAudioStreamIndexForSource,
  getDefaultSubtitleStreamIndexForSource,
} from "../../lib/playbackDefaults";
import type {
  JellyfinItem,
  JellyfinMediaStream,
  PlaybackQualityOption,
  PlaybackSourceCandidate,
  PlaybackSourceSettings,
} from "../../lib/types";

export function getStreamsOfType(
  source: PlaybackSourceCandidate,
  type: "Audio" | "Subtitle",
): JellyfinMediaStream[] {
  return (
    source.mediaSource.MediaStreams?.filter(
      (stream) => stream.Type?.toLowerCase() === type.toLowerCase(),
    ) ?? []
  );
}

export function getDefaultAudioStreamIndex(
  item: JellyfinItem,
  source: PlaybackSourceCandidate,
): number | undefined {
  return getDefaultAudioStreamIndexForSource(item, source);
}

export function getMediaSourceDefaultAudioStreamIndex(
  source: PlaybackSourceCandidate,
): number | undefined {
  const audioStreams = getStreamsOfType(source, "Audio");

  return (
    source.mediaSource.DefaultAudioStreamIndex ??
    audioStreams.find((stream) => stream.IsDefault)?.Index ??
    audioStreams[0]?.Index
  );
}

export function isDirectBrowserPlaybackSource(
  source: PlaybackSourceCandidate,
): boolean {
  return (
    !source.isHls &&
    (source.mode === "DirectPlay" || source.mode === "DirectStream")
  );
}

export function isAudioTranscodeSource(
  source: PlaybackSourceCandidate,
): boolean {
  return source.isHls && source.hlsKind === "audio-transcode";
}

export function hasUsefulBufferedRangeAroundCurrentTime(
  video: HTMLVideoElement,
  minAheadSeconds = 1.2,
): boolean {
  const currentTime = Number.isFinite(video.currentTime)
    ? video.currentTime
    : 0;

  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);

    if (
      currentTime >= start - 0.25 &&
      currentTime <= end &&
      end - currentTime >= minAheadSeconds
    ) {
      return true;
    }
  }

  return false;
}

export function isVideoReadyForAudioTranscodePlayback(
  video: HTMLVideoElement,
): boolean {
  return (
    video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
    hasUsefulBufferedRangeAroundCurrentTime(video, 1.2)
  );
}

export function getDefaultSubtitleStreamIndex(
  item: JellyfinItem,
  source: PlaybackSourceCandidate,
): number {
  return getDefaultSubtitleStreamIndexForSource(item, source);
}

export function shouldForceDefaultAudioInPlaybackUrl(
  source: PlaybackSourceCandidate,
): boolean {
  return source.mode === "Transcoding" || source.isHls;
}

export function canInjectDefaultAudioIntoStreamCopy(
  source: PlaybackSourceCandidate,
  defaultAudioIndex: number | undefined,
): boolean {
  return (
    defaultAudioIndex !== undefined &&
    source.isHls &&
    source.hlsKind === "stream-copy" &&
    source.mode !== "Transcoding"
  );
}

export function didUserSelectNonDefaultAudio(
  selectedAudioStreamIndex: number | undefined,
  defaultAudioStreamIndex: number | undefined,
): boolean {
  return (
    selectedAudioStreamIndex !== undefined &&
    defaultAudioStreamIndex !== undefined &&
    selectedAudioStreamIndex !== defaultAudioStreamIndex
  );
}

export function getAudioFallbackSource(
  source: PlaybackSourceCandidate,
  candidates: PlaybackSourceCandidate[],
): PlaybackSourceCandidate | null {
  if (
    source.mediaSource.Id &&
    (source.mediaSource.SupportsTranscoding || source.mode === "Transcoding")
  ) {
    return source;
  }

  return (
    candidates.find(
      (candidate) =>
        candidate.mediaSourceId === source.mediaSourceId &&
        candidate.mediaSource.Id &&
        (candidate.mode === "Transcoding" || candidate.isHls),
    ) ?? null
  );
}

export function getStreamByIndex(
  source: PlaybackSourceCandidate,
  type: "Audio" | "Subtitle",
  streamIndex: number,
): JellyfinMediaStream | undefined {
  return getStreamsOfType(source, type).find(
    (stream) => stream.Index === streamIndex,
  );
}

export function getQualitySettings(
  quality?: PlaybackQualityOption,
): PlaybackSourceSettings {
  if (!quality) {
    return {};
  }

  return {
    maxHeight: quality.maxHeight,
    maxWidth: quality.maxWidth,
    maxStreamingBitrate: quality.maxStreamingBitrate,
  };
}
