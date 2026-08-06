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

export interface MediaQualityManifest {
  mediaId: string;
  qualities: AvailableQualityFile[];
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

export function isMediaQualityManifest(
  value: unknown,
): value is MediaQualityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<MediaQualityManifest>;
  return (
    typeof manifest.mediaId === "string" &&
    Array.isArray(manifest.qualities) &&
    manifest.qualities.every(isAvailableQualityFile)
  );
}
