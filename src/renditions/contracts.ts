export type QualityPreferenceMode =
  | "low-data"
  | "auto"
  | "higher-resolution"
  | "advanced";

export interface AvailableQualityFile {
  id: string;
  label: string;
  kind: "original" | "generated";
  width: number;
  height: number;
  bitrate?: number;
  fileSize?: number;
  videoCodec?: string;
  audioCodec?: string;
  container?: string;
  /** True when the file carries the source HDR10 grade rather than SDR. */
  hdr?: boolean;
  playbackUrl: string;
  sourceAudioStreamIndex?: number;
  audioLanguage?: string;
}

export interface AdaptiveQualityLevel {
  id: string;
  label: string;
  width: number;
  height: number;
  bitrate: number;
  videoCodec: "h264" | "hevc";
  hdr: boolean;
}

export interface AdaptiveAudioTrack {
  id: string;
  sourceStreamIndex: number;
  label: string;
  language?: string;
  channels: number;
  isDefault: boolean;
}

export interface AdaptiveQualityManifest {
  profileVersion: string;
  playbackUrl: string;
  mimeType: "application/vnd.apple.mpegurl";
  segmentTargetSeconds: number;
  qualities: AdaptiveQualityLevel[];
  audioTracks: AdaptiveAudioTrack[];
  switching: "aligned-cmaf-hls";
}

export interface MediaQualityManifest {
  mediaId: string;
  qualities: AvailableQualityFile[];
  /** Preferred single-player adaptive switching set, when one validates. */
  adaptive?: AdaptiveQualityManifest;
  generatedAt?: string;
  limitations: {
    generatedAudio: "default-track-only";
    generatedSubtitles: "external-or-original-only";
    switching: "complete-file-rebuffer";
  };
}

const QUALITY_MODES = new Set<QualityPreferenceMode>([
  "low-data",
  "auto",
  "higher-resolution",
  "advanced",
]);

export function isQualityPreferenceMode(
  value: unknown,
): value is QualityPreferenceMode {
  return (
    typeof value === "string" &&
    QUALITY_MODES.has(value as QualityPreferenceMode)
  );
}

function isAvailableQualityFile(value: unknown): value is AvailableQualityFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const quality = value as Partial<AvailableQualityFile>;
  return (
    typeof quality.id === "string" &&
    typeof quality.label === "string" &&
    (quality.kind === "original" || quality.kind === "generated") &&
    typeof quality.width === "number" &&
    Number.isInteger(quality.width) &&
    quality.width > 0 &&
    typeof quality.height === "number" &&
    Number.isInteger(quality.height) &&
    quality.height > 0 &&
    typeof quality.playbackUrl === "string" &&
    quality.playbackUrl.length > 0
  );
}

function isAdaptiveQualityManifest(
  value: unknown,
): value is AdaptiveQualityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const adaptive = value as Partial<AdaptiveQualityManifest>;
  return (
    typeof adaptive.profileVersion === "string" &&
    typeof adaptive.playbackUrl === "string" &&
    adaptive.mimeType === "application/vnd.apple.mpegurl" &&
    typeof adaptive.segmentTargetSeconds === "number" &&
    adaptive.segmentTargetSeconds > 0 &&
    adaptive.switching === "aligned-cmaf-hls" &&
    Array.isArray(adaptive.qualities) &&
    adaptive.qualities.length > 0 &&
    adaptive.qualities.every(
      (quality) =>
        quality &&
        typeof quality.id === "string" &&
        typeof quality.label === "string" &&
        typeof quality.width === "number" &&
        typeof quality.height === "number" &&
        typeof quality.bitrate === "number" &&
        (quality.videoCodec === "h264" || quality.videoCodec === "hevc") &&
        typeof quality.hdr === "boolean",
    ) &&
    Array.isArray(adaptive.audioTracks) &&
    adaptive.audioTracks.length > 0 &&
    adaptive.audioTracks.every(
      (track) =>
        track &&
        typeof track.id === "string" &&
        typeof track.sourceStreamIndex === "number" &&
        typeof track.label === "string" &&
        typeof track.channels === "number" &&
        typeof track.isDefault === "boolean",
    )
  );
}

export function isMediaQualityManifest(
  value: unknown,
): value is MediaQualityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<MediaQualityManifest>;
  return (
    typeof manifest.mediaId === "string" &&
    Array.isArray(manifest.qualities) &&
    manifest.qualities.every(isAvailableQualityFile) &&
    (manifest.adaptive === undefined ||
      isAdaptiveQualityManifest(manifest.adaptive))
  );
}
