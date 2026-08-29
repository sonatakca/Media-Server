import { languageDisplayName } from "../processing/languages";
import type {
  AdaptiveAudioRenditionMetadata,
  AdaptivePackageMetadata,
  AdaptiveSubtitleRenditionMetadata,
  AdaptiveVideoRenditionMetadata,
} from "./metadata";
import {
  TITLE_AUDIO_DIRECTORY,
  TITLE_SUBTITLE_DIRECTORY,
  TITLE_VIDEO_DIRECTORY,
  audioFileStem,
  qualityLabel,
  subtitleFileStem,
} from "./layout";

/**
 * Turning a packaged ladder into the files a person sees in the title folder.
 *
 * The packager builds into a work directory whose names are stable and machine
 * shaped (`video/720p/media.m4s`). What lands in the library is named the way
 * someone browsing it would expect (`video/720p60.mp4`), and the playlists that
 * tie them together are rewritten to match — then hidden, so the folders the
 * user opens contain media and nothing else.
 */

/** Where the playlists and the package manifest live inside the title folder. */
export const TITLE_PACKAGE_DIRECTORY = ".seyirlik";
export const TITLE_PACKAGE_MANIFEST = "package.json";
export const TITLE_MASTER_PLAYLIST = "master.m3u8";

/** Prefix of the directory a publish stages into before swapping it in. */
export const TITLE_STAGING_PREFIX = ".seyirlik-publish";

export const VIDEO_FILE_EXTENSION = ".mp4";
/** fMP4 audio: the same container the video rungs use, so one demuxer serves both. */
export const AUDIO_FILE_EXTENSION = ".m4a";
export const SUBTITLE_FILE_EXTENSION = ".vtt";

export interface PublishedRendition {
  /** The rendition id the package already knows it by, e.g. `720p`. */
  id: string;
  /** Path of the media file, relative to the title folder. */
  mediaPath: string;
  /** Path of the playlist, relative to the title folder. */
  playlistPath: string;
  /** What the media file is called, without its extension. */
  stem: string;
}

export interface TitleLayoutPlan {
  video: PublishedRendition[];
  audio: PublishedRendition[];
  subtitle: PublishedRendition[];
  masterPlaylistPath: string;
  manifestPath: string;
}

/**
 * Makes a name unique within its own folder without making it ugly.
 *
 * Two tracks that reduce to the same name would otherwise be one file, and the
 * second would silently replace the first.
 */
function uniqueStem(stem: string, taken: Set<string>): string {
  const key = stem.toLowerCase();
  if (!taken.has(key)) {
    taken.add(key);
    return stem;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem} (${suffix})`;
    const candidateKey = candidate.toLowerCase();
    if (!taken.has(candidateKey)) {
      taken.add(candidateKey);
      return candidate;
    }
  }
}

export function videoStemFor(
  rendition: Pick<
    AdaptiveVideoRenditionMetadata,
    "qualityHeight" | "frameRate" | "hdr"
  >,
): string {
  return qualityLabel({
    qualityHeight: rendition.qualityHeight,
    frameRate: rendition.frameRate,
    isHdr: rendition.hdr !== "sdr",
  });
}

/**
 * The qualifier comes from the source's own dispositions, never from
 * `isDefault`: the track a container opens with is a playback preference, not a
 * claim about the language the film was shot in, so naming the default track
 * `(original)` mislabels every dub that ships as default.
 */
export function audioStemFor(
  rendition: Pick<
    AdaptiveAudioRenditionMetadata,
    "language" | "title" | "isOriginal" | "isCommentary"
  >,
): string {
  return audioFileStem({
    ...(rendition.language ? { language: rendition.language } : {}),
    ...(rendition.language
      ? { languageName: languageDisplayName(rendition.language) }
      : {}),
    ...(rendition.title ? { title: rendition.title } : {}),
    ...(rendition.isOriginal === undefined
      ? {}
      : { isOriginal: rendition.isOriginal }),
    ...(rendition.isCommentary === undefined
      ? {}
      : { isCommentary: rendition.isCommentary }),
  });
}

export function subtitleStemFor(
  rendition: Pick<
    AdaptiveSubtitleRenditionMetadata,
    "language" | "title" | "isForced" | "isHearingImpaired"
  >,
): string {
  return subtitleFileStem({
    ...(rendition.language ? { language: rendition.language } : {}),
    ...(rendition.language
      ? { languageName: languageDisplayName(rendition.language) }
      : {}),
    ...(rendition.title ? { title: rendition.title } : {}),
    isForced: rendition.isForced,
    isHearingImpaired: rendition.isHearingImpaired,
  });
}

/**
 * Every path a package will occupy inside the title folder.
 *
 * Computed before anything is written so a name collision is a plan that never
 * ran rather than a file that quietly overwrote another.
 */
export function planTitleLayout(
  metadata: Pick<
    AdaptivePackageMetadata,
    "videoRenditions" | "audioRenditions"
  > & {
    subtitleRenditions?: AdaptiveSubtitleRenditionMetadata[];
  },
): TitleLayoutPlan {
  const videoTaken = new Set<string>();
  const video = metadata.videoRenditions.map((rendition) => {
    const stem = uniqueStem(videoStemFor(rendition), videoTaken);
    return {
      id: rendition.id,
      stem,
      mediaPath: `${TITLE_VIDEO_DIRECTORY}/${stem}${VIDEO_FILE_EXTENSION}`,
      playlistPath: `${TITLE_PACKAGE_DIRECTORY}/${TITLE_VIDEO_DIRECTORY}/${stem}.m3u8`,
    };
  });

  const audioTaken = new Set<string>();
  const audio = metadata.audioRenditions.map((rendition) => {
    const stem = uniqueStem(audioStemFor(rendition), audioTaken);
    return {
      id: rendition.id,
      stem,
      mediaPath: `${TITLE_AUDIO_DIRECTORY}/${stem}${AUDIO_FILE_EXTENSION}`,
      playlistPath: `${TITLE_PACKAGE_DIRECTORY}/${TITLE_AUDIO_DIRECTORY}/${stem}.m3u8`,
    };
  });

  const subtitleTaken = new Set<string>();
  const subtitle = (metadata.subtitleRenditions ?? []).map((rendition) => {
    const stem = uniqueStem(subtitleStemFor(rendition), subtitleTaken);
    return {
      id: rendition.id,
      stem,
      mediaPath: `${TITLE_SUBTITLE_DIRECTORY}/${stem}${SUBTITLE_FILE_EXTENSION}`,
      playlistPath: `${TITLE_PACKAGE_DIRECTORY}/${TITLE_SUBTITLE_DIRECTORY}/${stem}.m3u8`,
    };
  });

  return {
    video,
    audio,
    subtitle,
    masterPlaylistPath: `${TITLE_PACKAGE_DIRECTORY}/${TITLE_MASTER_PLAYLIST}`,
    manifestPath: `${TITLE_PACKAGE_DIRECTORY}/${TITLE_PACKAGE_MANIFEST}`,
  };
}

/**
 * A path as an HLS playlist may carry it.
 *
 * The names are chosen to be read by people, so they contain spaces. A space is
 * not legal in a URI, and a player that resolves the raw name against the
 * playlist's own URL asks the server for something it will not recognise.
 */
export function playlistUri(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** How a playlist under `.seyirlik/<kind>/` reaches its media file. */
export function mediaUriFromPlaylist(mediaPath: string): string {
  return playlistUri(`../../${mediaPath}`);
}

/**
 * Points a rendition playlist at its published media file.
 *
 * Every segment line and the `EXT-X-MAP` initialisation range name the same
 * single file, so this is one substitution applied throughout rather than a
 * parse of the playlist's structure.
 */
export function rewriteRenditionPlaylist(
  playlist: string,
  workMediaFileName: string,
  publishedMediaPath: string,
): string {
  const target = mediaUriFromPlaylist(publishedMediaPath);
  return playlist
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("#EXT-X-MAP")) {
        return line.replace(
          new RegExp(`URI="${escapeRegExp(workMediaFileName)}"`),
          `URI="${target}"`,
        );
      }
      if (line.trim() === workMediaFileName) return target;
      return line;
    })
    .join("\n");
}

/**
 * Points the master at the published rendition playlists.
 *
 * The master sits in the package directory alongside them, so it names them
 * relative to itself rather than to the title folder.
 */
export function rewriteMasterPlaylist(
  master: string,
  plan: TitleLayoutPlan,
  workPlaylistPathById: ReadonlyMap<string, string>,
): string {
  const replacements = new Map<string, string>();
  for (const group of [plan.video, plan.audio, plan.subtitle]) {
    for (const rendition of group) {
      const from = workPlaylistPathById.get(rendition.id);
      if (!from) continue;
      replacements.set(
        from,
        playlistUri(
          rendition.playlistPath.slice(TITLE_PACKAGE_DIRECTORY.length + 1),
        ),
      );
    }
  }

  return master
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      const direct = replacements.get(trimmed);
      if (direct) return direct;
      if (!line.startsWith("#EXT-X-MEDIA")) return line;
      let rewritten = line;
      for (const [from, to] of replacements) {
        rewritten = rewritten.replace(`URI="${from}"`, `URI="${to}"`);
      }
      return rewritten;
    })
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
