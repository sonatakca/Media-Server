/**
 * The adaptive package profile.
 *
 * Deliberately not a new version of `h264-aac-mp4-v2`: the two describe
 * incompatible things. A legacy package is a set of complete, independently
 * playable MP4 files each carrying its own audio; an adaptive package is a
 * switching set of video-only CMAF renditions sharing separate audio, which
 * only means anything through its playlists. Reusing the identifier would let a
 * registry entry, a pointer or a metadata file written for one be accepted by
 * the reader for the other.
 *
 * Both generations coexist. `current.json` names a legacy package;
 * `current-adaptive.json` names an adaptive one, so activating either never
 * touches the other and a failed adaptive encode cannot invalidate a legacy
 * package that still plays.
 */

export const ADAPTIVE_PROFILE_VERSION = "cmaf-hls-aligned-v1";
export const ADAPTIVE_METADATA_SCHEMA_VERSION = 1;
export const ADAPTIVE_POINTER_SCHEMA_VERSION = 1;

/** Filename of the pointer naming the active adaptive version directory. */
export const ADAPTIVE_POINTER_FILE = "current-adaptive.json";

/** Layout inside a version directory. Mirrored by the validator and the server. */
export const ADAPTIVE_MASTER_PLAYLIST = "master.m3u8";
export const ADAPTIVE_METADATA_FILE = "metadata.json";
export const ADAPTIVE_VIDEO_DIRECTORY = "video";
export const ADAPTIVE_AUDIO_DIRECTORY = "audio";
export const ADAPTIVE_MEDIA_FILE = "media.m4s";
export const ADAPTIVE_PLAYLIST_FILE = "playlist.m3u8";

/**
 * Alignment slack allowed on top of one source-frame duration.
 *
 * Presentation timestamps are stored as integers in a timescale, so a boundary
 * that is exactly one frame in media time can still differ by a fraction of a
 * millisecond once rounded. Without a floor, a mathematically perfect ladder
 * fails validation on rounding alone.
 */
export const ALIGNMENT_EPSILON_SECONDS = 0.002;

/**
 * How far audio may fall short of, or overrun, the video timeline.
 *
 * AAC is framed in 1024-sample packets — 21.3ms at 48 kHz — so an audio
 * rendition practically never ends on the same instant as video. One tenth of a
 * second covers that without admitting a genuinely truncated track.
 */
export const AUDIO_DURATION_TOLERANCE_SECONDS = 0.5;

/** Video renditions must describe the same timeline as each other far more tightly. */
export const VIDEO_DURATION_TOLERANCE_SECONDS = 0.1;

export type AdaptiveQualityClass = 480 | 720 | 1080;

export const ADAPTIVE_QUALITY_CLASSES: readonly AdaptiveQualityClass[] = [
  480, 720, 1080,
];

export function isAdaptiveQualityClass(
  value: number,
): value is AdaptiveQualityClass {
  return ADAPTIVE_QUALITY_CLASSES.includes(value as AdaptiveQualityClass);
}

/** Stable rendition id used in playlists, metadata and capability URLs. */
export function videoRenditionId(qualityHeight: number): string {
  return `${qualityHeight}p`;
}

/**
 * Stable audio rendition id.
 *
 * Keyed by the source stream index rather than by ordinal position, so removing
 * a track from a later regeneration cannot silently re-point a saved audio
 * preference at a different language.
 */
export function audioRenditionId(sourceStreamIndex: number): string {
  return `track-${sourceStreamIndex}`;
}

const RENDITION_ID_PATTERN = /^(?:\d{2,4}p|track-\d{1,5})$/;

export function isSafeRenditionId(value: unknown): value is string {
  return typeof value === "string" && RENDITION_ID_PATTERN.test(value);
}
