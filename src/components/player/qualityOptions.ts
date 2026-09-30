import { formatTemplate } from "../../lib/format";
import type {
  PlaybackQualityOption,
  PlaybackSourceCandidate,
} from "../../lib/types";
import type { TranslationKey } from "../../i18n/translations";
import type {
  AvailableQualityFile,
  MediaQualityManifest,
} from "../../renditions/contracts";
import { sortQualityOptionsLowestFirst } from "./playerHelpers";
import { isQualityAudioCompatible } from "./qualityPreference";

/**
 * The source that plays one quality of the title.
 *
 * The original is served by whichever plan the backend already produced, so it
 * is returned untouched: rewriting it into a synthetic direct-play candidate
 * would drop the session id, transcode capability flags and audio-switching
 * fallbacks that original playback still depends on. Only generated complete
 * files become new candidates.
 */
export function buildQualityFileSourceFor(
  source: PlaybackSourceCandidate,
  qualityManifest: MediaQualityManifest | undefined,
  quality: AvailableQualityFile,
): PlaybackSourceCandidate {
  return quality.kind === "original"
    ? source.hlsKind === "adaptive-rendition"
      ? {
          ...source,
          id: "quality-file-original",
          url: quality.playbackUrl,
          mode: "DirectPlay",
          isHls: false,
          hlsKind: "direct",
          usingHlsJs: false,
          mimeType: quality.container === "mp4" ? "video/mp4" : undefined,
          label: quality.label,
          reason: "Original file outside the adaptive switching set.",
          transcodeReasons: [],
        }
      : source
    : {
        ...source,
        id: `quality-file-${quality.id}`,
        // Generated renditions still use the original media file's
        // subtitle inventory. Keep its authorized playback session so
        // sidecar and embedded subtitle tracks remain downloadable while
        // the generated video file is on screen.
        playSessionId: source.playSessionId,
        mode: "DirectPlay",
        url: quality.playbackUrl,
        mimeType: quality.container === "mp4" ? "video/mp4" : undefined,
        isHls: false,
        hlsKind: undefined,
        label: quality.label,
        qualityManifest,
        reason: "Validated pre-generated complete rendition file.",
        transcodeReasons: [],
        mediaSource: {
          ...source.mediaSource,
          Container: quality.container ?? source.mediaSource.Container,
          SupportsDirectPlay: true,
          SupportsDirectStream: false,
          SupportsTranscoding: false,
        },
      };
}

interface AdvancedQualityOptionsInput {
  /** Present only when the adaptive package has rungs to offer. */
  adaptiveManifest: MediaQualityManifest["adaptive"] | undefined;
  availableQualityFiles: readonly AvailableQualityFile[];
  selectedAudioStreamIndex: number | undefined;
  t: (key: TranslationKey) => string;
}

/** The rungs the manual picker lists, lowest first. */
export function buildAdvancedQualityOptions({
  adaptiveManifest,
  availableQualityFiles,
  selectedAudioStreamIndex,
  t,
}: AdvancedQualityOptionsInput): PlaybackQualityOption[] {
  if (adaptiveManifest && adaptiveManifest.qualities.length > 0) {
    const adaptiveOptions = adaptiveManifest.qualities.map((quality) => ({
      id: quality.id,
      label: quality.label,
      subtitle: "",
      maxHeight: quality.height,
      maxWidth: quality.width,
      maxStreamingBitrate: quality.bitrate,
    }));
    const original = availableQualityFiles.find(
      (quality) => quality.kind === "original",
    );
    return sortQualityOptionsLowestFirst(
      original
        ? [
            ...adaptiveOptions,
            {
              id: original.id,
              label: formatTemplate(t("player.qualityOriginalWithHeight"), {
                height: original.height,
              }),
              subtitle: "",
              maxHeight: original.height,
              maxWidth: original.width,
              maxStreamingBitrate: original.bitrate ?? Number.MAX_SAFE_INTEGER,
            },
          ]
        : adaptiveOptions,
    );
  }
  return sortQualityOptionsLowestFirst(
    availableQualityFiles.map((quality) => ({
      id: quality.id,
      label: `${
        quality.kind === "original"
          ? formatTemplate(t("player.qualityOriginalWithHeight"), {
              height: quality.height,
            })
          : `${quality.height}p`
      }${quality.hdr ? " HDR" : ""}`,
      // Only carry a subtitle when it says something the label does not; the
      // check mark already marks the active entry.
      subtitle: isQualityAudioCompatible(quality, selectedAudioStreamIndex)
        ? ""
        : t("player.qualityAudioMismatch"),
      maxHeight: quality.height,
      maxWidth: quality.width,
      maxStreamingBitrate: quality.bitrate ?? Number.MAX_SAFE_INTEGER,
    })),
  );
}
