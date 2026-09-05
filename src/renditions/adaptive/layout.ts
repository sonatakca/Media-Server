/**
 * Where a title's generated media lives, and what each file is called.
 *
 * Everything a title owns sits inside the title's own folder rather than in a
 * parallel tree keyed by an opaque id:
 *
 * ```
 * Dune (2021)/
 *   Dune (2021).mp4          the source, untouched
 *   content/                 backdrop, cover, logo, trailers
 *   video/2160p60 HDR.mp4    video only, no audio
 *   audio/english.m4a        one file per kept language
 *   subtitle/english.vtt
 * ```
 *
 * The names are the ones a person would choose, because a library laid out this
 * way can be read, moved and backed up without the server. Cache correctness
 * does not depend on them: the package's build stamp lives in the URL, so a
 * regenerated rendition is served from a new URL even though the file on disk
 * keeps its name.
 */

/** Directories a title owns inside its own folder. */
export const TITLE_VIDEO_DIRECTORY = "video";
export const TITLE_AUDIO_DIRECTORY = "audio";
export const TITLE_SUBTITLE_DIRECTORY = "subtitle";
export const TITLE_CONTENT_DIRECTORY = "content";

/**
 * Where a title's *original* files live once a library has been organised.
 *
 * Sources and their sidecar subtitles are the only things in a media folder a
 * person did not ask this server to create, and they are also the noisiest: a
 * season folder holds ten of them interleaved with ten generated folders. Put
 * together in `src/`, the folder someone opens reads as "one entry per episode,
 * plus the originals", which is the layout the rest of this file assumes:
 *
 * ```
 * Series/Andor/Season 1/
 *   src/
 *     Andor - S01E01 - Kassa.mp4       the source, untouched
 *     Andor - S01E01 - Kassa.tr.srt    its sidecar subtitle
 *   Andor - S01E01 - Kassa/
 *     Andor - S01E01 - Kassa.nfo       the episode's own metadata
 *     video/ audio/ subtitle/          what was generated from it
 * ```
 *
 * A title root is unaffected by the move: `src/` is transparent to the code
 * that decides where a package goes, so a package written before the library
 * was organised keeps its address afterwards. See `titleRoot.ts`.
 */
export const TITLE_SOURCE_DIRECTORY = "src";

/**
 * Directory names the library scanner must not walk into as if they held
 * separate titles.
 *
 * Every one of these holds real video files that belong to the title above
 * them, so without this a seven-rung ladder would scan as seven more movies.
 */
export const GENERATED_TITLE_DIRECTORIES: ReadonlySet<string> = new Set([
  TITLE_VIDEO_DIRECTORY,
  TITLE_AUDIO_DIRECTORY,
  TITLE_SUBTITLE_DIRECTORY,
  TITLE_CONTENT_DIRECTORY,
]);

/**
 * The rungs a ladder may contain, largest first.
 *
 * 1440p earns its place on a 4K source: the step from 1080p to 2160p is a
 * fourfold jump in pixels and roughly a doubling in bitrate, which is a long
 * way for a link to fall in one move, and it is the rung most large displays
 * can actually use without paying for 4K.
 */
export const LADDER_QUALITY_CLASSES: readonly number[] = [
  2160, 1440, 1080, 720, 480, 360, 240, 144,
];

/**
 * A source is treated as high-frame-rate from this rate up.
 *
 * 50 rather than 60 so that 50 Hz broadcast material is recognised as the same
 * class rather than being quietly halved.
 */
export const HIGH_FRAME_RATE_THRESHOLD = 50;

/** The highest frame rate a rung may carry. */
export const HIGH_FRAME_RATE_CEILING = 60;
export const STANDARD_FRAME_RATE_CEILING = 30;

/**
 * The smallest rung that may keep a high frame rate.
 *
 * Below 720p the extra frames buy nothing a viewer on that rung can see, and
 * they are being served precisely because bandwidth is short — so the rungs
 * that exist to be small stay small.
 */
export const HIGH_FRAME_RATE_MINIMUM_CLASS = 720;

/**
 * The frame rate a rung is encoded at.
 *
 * Never above the source: a rung is a smaller version of what exists, never an
 * invention of frames that were never shot.
 */
export function frameRateForClass(
  qualityHeight: number,
  sourceFrameRate: number | undefined,
): number | undefined {
  if (!sourceFrameRate || !Number.isFinite(sourceFrameRate)) return undefined;
  const ceiling =
    qualityHeight >= HIGH_FRAME_RATE_MINIMUM_CLASS
      ? HIGH_FRAME_RATE_CEILING
      : STANDARD_FRAME_RATE_CEILING;
  return Math.min(sourceFrameRate, ceiling);
}

export interface QualityLabelInput {
  qualityHeight: number;
  frameRate?: number;
  isHdr?: boolean;
}

/**
 * What a rung is called, in the settings panel and on disk.
 *
 * `1080p60`, `2160p60 HDR`, `480p`. The frame rate is joined to the height
 * because "1080p60" is one word for one thing; HDR is separated because it
 * describes the picture rather than its size.
 */
export function qualityLabel({
  qualityHeight,
  frameRate,
  isHdr,
}: QualityLabelInput): string {
  const highFrameRate =
    frameRate !== undefined && frameRate >= HIGH_FRAME_RATE_THRESHOLD;
  return `${qualityHeight}p${highFrameRate ? "60" : ""}${isHdr ? " HDR" : ""}`;
}

/**
 * A label reduced to something safe on every filesystem we support.
 *
 * Deliberately conservative rather than clever: a name that survives a copy to
 * a FAT volume, a zip and a Windows share is worth more than one that keeps
 * every character of the source metadata.
 */ export function safeFileStem(value: string): string {
  const cleaned = value
    .normalize("NFC")
    // Reserved on Windows, awkward in every shell. Spaces, hyphens and
    // parentheses are kept: they are what makes "2160p60 HDR" readable.
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A trailing dot or space makes a file unopenable on Windows.
    .replace(/[. ]+$/, "");
  return cleaned || "untitled";
}

export interface AudioRenditionNaming {
  language?: string;
  languageName?: string;
  title?: string;
  isOriginal?: boolean;
  isCommentary?: boolean;
}

/**
 * The filename stem for a kept audio track.
 *
 * Named by its language rather than by its stream index, because the file is
 * meant to be legible to whoever opens the folder. This describes the track and
 * nothing else — making two tracks that reduce to the same name unique belongs
 * to whoever is laying out the folder, which is the only place that knows what
 * names are already taken.
 */
export function audioFileStem(track: AudioRenditionNaming): string {
  const base = (track.languageName ?? track.language ?? "audio").toLowerCase();
  const qualifier = track.isCommentary
    ? " (commentary)"
    : track.isOriginal
      ? " (original)"
      : "";
  return safeFileStem(`${base}${qualifier}`);
}

export interface SubtitleRenditionNaming {
  language?: string;
  languageName?: string;
  title?: string;
  isForced?: boolean;
  isHearingImpaired?: boolean;
}

/**
 * The filename stem for a kept subtitle track.
 *
 * A forced track and a full one in the same language are different files a
 * viewer chooses between, so the distinction has to survive into the name.
 */
export function subtitleFileStem(track: SubtitleRenditionNaming): string {
  const base = (
    track.languageName ??
    track.language ??
    "subtitle"
  ).toLowerCase();
  const qualifiers: string[] = [];
  if (track.isForced) qualifiers.push("forced");
  if (track.isHearingImpaired) qualifiers.push("sdh");
  const suffix = qualifiers.length > 0 ? ` (${qualifiers.join(" ")})` : "";
  return safeFileStem(`${base}${suffix}`);
}
