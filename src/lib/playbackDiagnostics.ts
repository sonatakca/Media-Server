import { redactPlaybackUrl } from "./jellyfinApi";
import type { TranslationKey } from "../i18n/translations";
import type { JellyfinMediaSource, JellyfinMediaStream, PlaybackSourceCandidate } from "./types";

type Translate = (key: TranslationKey) => string;

export function getPlaybackModeLabel(mode?: string, t?: Translate): string {
  if (mode === "DirectPlay") return t ? t("playback.mode.directPlay") : "Direct Play";
  if (mode === "DirectStream") return t ? t("playback.mode.directStream") : "Direct Stream";
  if (mode === "Transcoding") return t ? t("playback.mode.transcoding") : "Transcoding";
  return t ? t("playback.mode.unknown") : "Unknown";
}

export function getPlaybackModeTone(mode?: string): string {
  if (mode === "DirectPlay") {
    return "border-emerald-300/25 bg-emerald-300/12 text-emerald-100";
  }

  if (mode === "DirectStream") {
    return "border-sky-300/25 bg-sky-300/12 text-sky-100";
  }

  if (mode === "Transcoding") {
    return "border-amber-300/30 bg-amber-300/14 text-amber-100";
  }

  return "border-white/15 bg-white/10 text-white/80";
}

export function getStreamOfType(
  mediaSource: JellyfinMediaSource | undefined,
  type: "Video" | "Audio",
): JellyfinMediaStream | undefined {
  return mediaSource?.MediaStreams?.find((stream) => stream.Type?.toLowerCase() === type.toLowerCase());
}

export function getSubtitleStreams(mediaSource: JellyfinMediaSource | undefined): JellyfinMediaStream[] {
  return mediaSource?.MediaStreams?.filter((stream) => stream.Type?.toLowerCase() === "subtitle") ?? [];
}

export function formatBytes(bytes?: number, unknownLabel = "Unknown"): string {
  if (!bytes || bytes <= 0) return unknownLabel;

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatBitrate(bits?: number, unknownLabel = "Unknown"): string {
  if (!bits || bits <= 0) return unknownLabel;

  if (bits >= 1_000_000) {
    return `${(bits / 1_000_000).toFixed(1)} Mbps`;
  }

  if (bits >= 1_000) {
    return `${Math.round(bits / 1_000)} kbps`;
  }

  return `${bits} bps`;
}

const JELLYFIN_TRANSCODE_REASON_KEYS: Record<string, TranslationKey> = {
  ContainerNotSupported: "playback.reason.containerNotSupported",
  VideoCodecNotSupported: "playback.reason.videoCodecNotSupported",
  AudioCodecNotSupported: "playback.reason.audioCodecNotSupported",
  SubtitleCodecNotSupported: "playback.reason.subtitleCodecNotSupported",
  AudioIsExternal: "playback.reason.audioIsExternal",
  SecondaryAudioNotSupported: "playback.reason.secondaryAudioNotSupported",
  VideoProfileNotSupported: "playback.reason.videoProfileNotSupported",
  VideoLevelNotSupported: "playback.reason.videoLevelNotSupported",
  VideoResolutionNotSupported: "playback.reason.videoResolutionNotSupported",
  VideoBitDepthNotSupported: "playback.reason.videoBitDepthNotSupported",
  VideoFramerateNotSupported: "playback.reason.videoFramerateNotSupported",
  RefFramesNotSupported: "playback.reason.refFramesNotSupported",
  AnamorphicVideoNotSupported: "playback.reason.anamorphicVideoNotSupported",
  InterlacedVideoNotSupported: "playback.reason.interlacedVideoNotSupported",
  AudioChannelsNotSupported: "playback.reason.audioChannelsNotSupported",
  AudioProfileNotSupported: "playback.reason.audioProfileNotSupported",
  AudioSampleRateNotSupported: "playback.reason.audioSampleRateNotSupported",
  AudioBitDepthNotSupported: "playback.reason.audioBitDepthNotSupported",
  ContainerBitrateExceedsLimit: "playback.reason.containerBitrateExceedsLimit",
  VideoBitrateNotSupported: "playback.reason.videoBitrateNotSupported",
  AudioBitrateNotSupported: "playback.reason.audioBitrateNotSupported",
  UnknownVideoStreamInfo: "playback.reason.unknownVideoStreamInfo",
  UnknownAudioStreamInfo: "playback.reason.unknownAudioStreamInfo",
  DirectPlayError: "playback.reason.directPlayError",
  VideoRangeTypeNotSupported: "playback.reason.videoRangeTypeNotSupported",
  VideoCodecTagNotSupported: "playback.reason.videoCodecTagNotSupported",
  StreamCountExceedsLimit: "playback.reason.streamCountExceedsLimit",
};

function getReadableTranscodeReasonKey(reason: string): TranslationKey | null {
  const exactMatch = JELLYFIN_TRANSCODE_REASON_KEYS[reason];

  if (exactMatch) {
    return exactMatch;
  }

  const normalized = reason.toLowerCase();

  if (normalized.includes("container")) return "playback.reason.container";
  if (normalized.includes("videocodec") || normalized.includes("video codec")) return "playback.reason.videoCodec";
  if (normalized.includes("audiocodec") || normalized.includes("audio codec")) return "playback.reason.audioCodec";
  if (normalized.includes("subtitle")) return "playback.reason.subtitle";
  if (normalized.includes("bitrate")) return "playback.reason.bitrate";
  if (normalized.includes("resolution")) return "playback.reason.resolution";
  if (normalized.includes("videorangetype") || normalized.includes("range type")) {
    return "playback.reason.videoRangeTypeNotSupported";
  }
  if (normalized.includes("audiochannels") || normalized.includes("channels")) {
    return "playback.reason.audioChannelsNotSupported";
  }

  return null;
}

function getSourceReasonKey(reason: string): TranslationKey | null {
  const normalized = reason.toLowerCase();

  if (normalized.includes("transcoding url from playbackinfo")) return "playback.reason.jellyfinTranscodingUrl";
  if (normalized.includes("hls fallback url")) return "playback.reason.hlsFallback";
  if (normalized.includes("browser-compatible")) return "playback.reason.browserCompatible";
  if (normalized.includes("last resort")) return "playback.reason.directRisky";

  if (normalized.includes("selected player setting") || normalized.includes("selected audio track")) {
    return "playback.reason.selectedSetting";
  }

  return null;
}

export function getReadableTranscodeReason(reason: string, t?: Translate): string {
  const reasonKey = getReadableTranscodeReasonKey(reason);
  return reasonKey && t ? t(reasonKey) : reason;
}

export function getPrimaryTranscodeReasons(source: PlaybackSourceCandidate, t?: Translate): string[] {
  const rawReasons = [
    ...(source.transcodeReasons ?? []),
    ...(source.mediaSource.TranscodingReasons ?? []),
  ];

  return Array.from(
    new Set(
      rawReasons
        .filter(Boolean)
        .map((reason) => getReadableTranscodeReason(reason, t)),
    ),
  );
}

export function getPlaybackReasons(source: PlaybackSourceCandidate, t?: Translate): string[] {
  const reasons: string[] = [];

  if (source.transcodeReasons?.length) {
    reasons.push(...source.transcodeReasons.map((reason) => getReadableTranscodeReason(reason, t)));
  }

  if (source.mediaSource.TranscodingReasons?.length) {
    reasons.push(...source.mediaSource.TranscodingReasons.map((reason) => getReadableTranscodeReason(reason, t)));
  }

  if (source.directPlayError) {
    reasons.push(source.directPlayError);
  }

  if (source.mediaSource.DirectPlayError) {
    reasons.push(source.mediaSource.DirectPlayError);
  }

  if (source.reason) {
    const sourceReasonKey = getSourceReasonKey(source.reason);
    reasons.push(sourceReasonKey && t ? t(sourceReasonKey) : source.reason);
  }

  if (reasons.length === 0) {
    reasons.push(
      t
        ? t("playback.reason.jellyfinSpecific")
        : "Jellyfin did not provide a specific reason. Check the server logs or PlaybackInfo response.",
    );
  }

  return Array.from(new Set(reasons));
}

export function getDirectPlayRecommendation(source: PlaybackSourceCandidate, t?: Translate): string[] {
  const mediaSource = source.mediaSource;
  const video = getStreamOfType(mediaSource, "Video");
  const audio = getStreamOfType(mediaSource, "Audio");
  const subtitles = getSubtitleStreams(mediaSource);

  const recommendations: string[] = [
    t
      ? t("playback.recommendation.browserTarget")
      : "For maximum browser compatibility, use MP4 container with H.264 video and AAC audio.",
  ];

  const container = mediaSource.Container?.toLowerCase() ?? "";
  const videoCodec = video?.Codec?.toLowerCase() ?? "";
  const audioCodec = audio?.Codec?.toLowerCase() ?? "";
  const hasHdr =
    video?.VideoRange?.toLowerCase().includes("hdr") ||
    video?.VideoRangeType?.toLowerCase().includes("hdr") ||
    video?.VideoRangeType?.toLowerCase().includes("dolby");

  if (container.includes("mkv") || container.includes("matroska")) {
    recommendations.push(
      t
        ? t("playback.recommendation.mkv")
        : "Current container looks like MKV/Matroska. Browser playback is safer with MP4.",
    );
  }

  if (videoCodec.includes("hevc") || videoCodec.includes("h265")) {
    recommendations.push(
      t
        ? t("playback.recommendation.hevc")
        : "Current video appears to be HEVC/H.265. Support varies by browser and device; H.264 is safer.",
    );
  }

  if (videoCodec.includes("av1")) {
    recommendations.push(
      t
        ? t("playback.recommendation.av1")
        : "AV1 support is improving, but H.264 is still the safest choice for older devices.",
    );
  }

  if (["opus", "flac", "dts", "truehd"].some((codec) => audioCodec.includes(codec))) {
    recommendations.push(
      t
        ? t("playback.recommendation.audio")
        : "Current audio codec may trigger audio transcoding. AAC stereo or AAC 5.1 is safer.",
    );
  }

  if (subtitles.some((subtitle) => ["ass", "ssa", "pgs", "vobsub"].includes((subtitle.Codec ?? "").toLowerCase()))) {
    recommendations.push(
      t
        ? t("playback.recommendation.subtitles")
        : "ASS/SSA/PGS/VobSub subtitles may require burn-in. External SRT/WebVTT subtitles are safer.",
    );
  }

  if (hasHdr) {
    recommendations.push(
      t
        ? t("playback.recommendation.hdr")
        : "HDR or Dolby Vision may require tone mapping on unsupported clients. SDR H.264 is safer for maximum compatibility.",
    );
  }

  recommendations.push(
    t
      ? t("playback.recommendation.bestTarget")
      : "Best target: SDR H.264 + AAC in MP4, with external SRT subtitles.",
  );

  return recommendations;
}

export function getSanitizedDebugPayload(source: PlaybackSourceCandidate, videoError?: string | null) {
  return {
    mode: source.mode,
    mediaSourceId: source.mediaSourceId,
    playSessionId: source.playSessionId,
    isHls: source.isHls,
    usingHlsJs: source.usingHlsJs,
    selectedUrl: redactPlaybackUrl(source.url),
    mimeType: source.mimeType,
    reason: source.reason,
    transcodeReasons: source.transcodeReasons,
    directPlayError: source.directPlayError,
    mediaSource: {
      Id: source.mediaSource.Id,
      Name: source.mediaSource.Name,
      Protocol: source.mediaSource.Protocol,
      Container: source.mediaSource.Container,
      SupportsDirectPlay: source.mediaSource.SupportsDirectPlay,
      SupportsDirectStream: source.mediaSource.SupportsDirectStream,
      SupportsTranscoding: source.mediaSource.SupportsTranscoding,
      TranscodingSubProtocol: source.mediaSource.TranscodingSubProtocol,
      TranscodingContainer: source.mediaSource.TranscodingContainer,
      TranscodingReasons: source.mediaSource.TranscodingReasons,
    },
    playbackInfo: {
      PlaySessionId: source.playbackInfo?.PlaySessionId,
      ErrorCode: source.playbackInfo?.ErrorCode,
      MediaSources: source.playbackInfo?.MediaSources?.length ?? 0,
    },
    videoError,
  };
}