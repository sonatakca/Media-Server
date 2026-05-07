import { redactPlaybackUrl } from "./jellyfinApi";
import type { JellyfinMediaSource, JellyfinMediaStream, PlaybackSourceCandidate } from "./types";

export function getPlaybackModeLabel(mode?: string): string {
  if (mode === "DirectPlay") return "Direct Play";
  if (mode === "DirectStream") return "Direct Stream";
  if (mode === "Transcoding") return "Transcoding";
  return "Unknown";
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

export function getStreamOfType(mediaSource: JellyfinMediaSource | undefined, type: "Video" | "Audio"): JellyfinMediaStream | undefined {
  return mediaSource?.MediaStreams?.find((stream) => stream.Type?.toLowerCase() === type.toLowerCase());
}

export function getSubtitleStreams(mediaSource: JellyfinMediaSource | undefined): JellyfinMediaStream[] {
  return mediaSource?.MediaStreams?.filter((stream) => stream.Type?.toLowerCase() === "subtitle") ?? [];
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "Unknown";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatBitrate(bits?: number): string {
  if (!bits || bits <= 0) return "Unknown";

  if (bits >= 1_000_000) {
    return `${(bits / 1_000_000).toFixed(1)} Mbps`;
  }

  if (bits >= 1_000) {
    return `${Math.round(bits / 1_000)} kbps`;
  }

  return `${bits} bps`;
}

export function getReadableTranscodeReason(reason: string): string {
  const normalized = reason.toLowerCase();

  if (normalized.includes("container")) return "Container not supported by the browser or selected client profile.";
  if (normalized.includes("videocodec") || normalized.includes("video codec")) return "Video codec not supported.";
  if (normalized.includes("audiocodec") || normalized.includes("audio codec")) return "Audio codec not supported.";
  if (normalized.includes("subtitle")) return "Subtitle format or burn-in requirement may require transcoding.";
  if (normalized.includes("bitrate")) return "Bitrate limit requires transcoding.";
  if (normalized.includes("resolution")) return "Resolution limit requires transcoding.";
  if (normalized.includes("audiochannels") || normalized.includes("channels")) return "Audio channel limit requires transcoding.";

  return reason;
}

export function getPlaybackReasons(source: PlaybackSourceCandidate): string[] {
  const reasons = source.transcodeReasons?.length
    ? source.transcodeReasons.map(getReadableTranscodeReason)
    : [];

  if (source.directPlayError) {
    reasons.push(source.directPlayError);
  }

  if (source.reason) {
    reasons.push(source.reason);
  }

  if (reasons.length === 0) {
    reasons.push("Jellyfin did not provide a specific reason. Check the server logs or PlaybackInfo response.");
  }

  return Array.from(new Set(reasons));
}

export function getDirectPlayRecommendation(source: PlaybackSourceCandidate): string[] {
  const mediaSource = source.mediaSource;
  const video = getStreamOfType(mediaSource, "Video");
  const audio = getStreamOfType(mediaSource, "Audio");
  const subtitles = getSubtitleStreams(mediaSource);

  const recommendations: string[] = [
    "For maximum browser compatibility, use MP4 container with H.264 video and AAC audio.",
  ];

  const container = mediaSource.Container?.toLowerCase() ?? "";
  const videoCodec = video?.Codec?.toLowerCase() ?? "";
  const audioCodec = audio?.Codec?.toLowerCase() ?? "";
  const hasHdr =
    video?.VideoRange?.toLowerCase().includes("hdr") ||
    video?.VideoRangeType?.toLowerCase().includes("hdr") ||
    video?.VideoRangeType?.toLowerCase().includes("dolby");

  if (container.includes("mkv") || container.includes("matroska")) {
    recommendations.push("Current container looks like MKV/Matroska. Browser playback is safer with MP4.");
  }

  if (videoCodec.includes("hevc") || videoCodec.includes("h265")) {
    recommendations.push("Current video appears to be HEVC/H.265. Support varies by browser and device; H.264 is safer.");
  }

  if (videoCodec.includes("av1")) {
    recommendations.push("AV1 support is improving, but H.264 is still the safest choice for older devices.");
  }

  if (["opus", "flac", "dts", "truehd"].some((codec) => audioCodec.includes(codec))) {
    recommendations.push("Current audio codec may trigger audio transcoding. AAC stereo or AAC 5.1 is safer.");
  }

  if (subtitles.some((subtitle) => ["ass", "ssa", "pgs", "vobsub"].includes((subtitle.Codec ?? "").toLowerCase()))) {
    recommendations.push("ASS/SSA/PGS/VobSub subtitles may require burn-in. External SRT/WebVTT subtitles are safer.");
  }

  if (hasHdr) {
    recommendations.push("HDR or Dolby Vision may require tone mapping on unsupported clients. SDR H.264 is safer for maximum compatibility.");
  }

  recommendations.push("Best target: SDR H.264 + AAC in MP4, with external SRT subtitles.");

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