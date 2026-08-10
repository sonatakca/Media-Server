/**
 * Filename and folder-name interpretation.
 *
 * Everything here is pure so the naming rules can be exercised against real
 * library samples without touching a filesystem or a database. The parser is
 * deliberately conservative: when a name cannot be understood it returns the
 * cleaned title and no episode/season numbers rather than guessing, because a
 * wrong guess silently files an episode under the wrong series.
 */

export const VIDEO_EXTENSIONS = new Set([
  "mkv",
  "mp4",
  "m4v",
  "avi",
  "mov",
  "wmv",
  "webm",
  "ts",
  "m2ts",
  "mpg",
  "mpeg",
  "flv",
  "ogv",
]);

export const BOOK_EXTENSIONS = new Set(["epub", "pdf", "cbz", "cbr"]);

export const SUBTITLE_EXTENSIONS = new Set([
  "srt",
  "ass",
  "ssa",
  "vtt",
  "sub",
  "sup",
]);

/**
 * Tokens that mark the end of a title in a scene-style release name. The list is
 * matched case-insensitively against whole tokens only, so a film called "Dune"
 * is never truncated by the substring "un".
 */
const RELEASE_TOKENS = new Set([
  "1080p",
  "1080i",
  "720p",
  "480p",
  "576p",
  "2160p",
  "4k",
  "uhd",
  "hd",
  "sd",
  "bluray",
  "blu-ray",
  "brrip",
  "bdrip",
  "bdremux",
  "remux",
  "webrip",
  "web-dl",
  "webdl",
  "web",
  "hdtv",
  "dvdrip",
  "dvd",
  "hdrip",
  "camrip",
  "cam",
  "ts",
  "tc",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "avc",
  "av1",
  "xvid",
  "divx",
  "vp9",
  "10bit",
  "8bit",
  "hdr",
  "hdr10",
  "hdr10plus",
  "dv",
  "dolbyvision",
  "sdr",
  "aac",
  "ac3",
  "eac3",
  "dts",
  "dts-hd",
  "truehd",
  "atmos",
  "flac",
  "mp3",
  "opus",
  "ddp",
  "dd",
  "dd5",
  "proper",
  "repack",
  "480i",
  "internal",
  "limited",
  "extended",
  "unrated",
  "remastered",
  "imax",
  "multi",
  "dual",
  "dubbed",
  "subbed",
  "hqcam",
  "amzn",
  "nf",
  "hmax",
  "dsnp",
  "atvp",
  "hulu",
  "ma",
]);

const YEAR_PATTERN = /^(19\d{2}|20\d{2}|21\d{2})$/;
const PARENTHESIZED_YEAR = /\((19\d{2}|20\d{2}|21\d{2})\)\s*$/;

export interface ParsedTitle {
  title: string;
  year?: number;
}

export interface ParsedEpisode extends ParsedTitle {
  seasonNumber?: number;
  /** First episode number for a multi-episode file. */
  episodeNumber?: number;
  /** Set only when one file contains a contiguous episode range. */
  endEpisodeNumber?: number;
  seriesTitle?: string;
  episodeTitle?: string;
}

export function splitExtension(fileName: string): {
  stem: string;
  extension: string;
} {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    return { stem: fileName, extension: "" };
  }
  return {
    stem: fileName.slice(0, dot),
    extension: fileName.slice(dot + 1).toLowerCase(),
  };
}

export function isVideoFile(fileName: string): boolean {
  return VIDEO_EXTENSIONS.has(splitExtension(fileName).extension);
}

export function isBookFile(fileName: string): boolean {
  return BOOK_EXTENSIONS.has(splitExtension(fileName).extension);
}

export function isSubtitleFile(fileName: string): boolean {
  return SUBTITLE_EXTENSIONS.has(splitExtension(fileName).extension);
}

/**
 * Hidden entries, macOS/Windows sidecars, and the directories Seyirlik itself
 * writes into the media volume are never catalogued.
 */
export function isIgnoredEntry(name: string): boolean {
  return (
    name.startsWith(".") ||
    name === "@eaDir" ||
    name === "lost+found" ||
    name.toLowerCase() === "thumbs.db" ||
    name.toLowerCase() === "desktop.ini"
  );
}

const EXTRA_DIRECTORY_NAMES = new Set([
  // Media managers write video backdrops and theme clips beside a title. They
  // contain real video files, so without this they scan as separate movies.
  "backdrops",
  "backdrop",
  "theme-music",
  "theme videos",
  "extrafanart",
  "extrathumbs",
  ".actors",
  "extras",
  "featurettes",
  "behind the scenes",
  "deleted scenes",
  "interviews",
  "scenes",
  "shorts",
  "trailers",
  "specials features",
  "other",
  "sample",
  "samples",
  "subs",
  "subtitles",
]);

export function isExtraDirectory(name: string): boolean {
  return EXTRA_DIRECTORY_NAMES.has(name.trim().toLowerCase());
}

export function isTrailerFile(stem: string): boolean {
  return /(^|[-_. ])trailer\d*$/i.test(stem.trim());
}

export function isSampleFile(stem: string): boolean {
  return /(^|[-_. ])sample$/i.test(stem.trim());
}

function tokenize(value: string): string[] {
  return value
    .replace(/[_]+/g, " ")
    .replace(/\s*\.\s*/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function stripBracketed(value: string): string {
  // Release groups and checksums live in [] and {}; parentheses are kept because
  // they usually carry the year.
  return value.replace(/\[[^\]]*\]/g, " ").replace(/\{[^}]*\}/g, " ");
}

function isReleaseToken(token: string): boolean {
  const normalized = token.toLowerCase().replace(/[()[\]]/g, "");
  if (!normalized) return false;
  if (RELEASE_TOKENS.has(normalized)) return true;
  // Audio layout and bitrate fragments left over by tokenization: DDP5, 640kbps.
  return /^\d{2,4}kbps$/.test(normalized) || /^(?:ddp|dd|dts|e?ac3)\d$/.test(normalized);
}

function cleanTitleTokens(tokens: string[]): string {
  return tokens
    .join(" ")
    .replace(/\s*[-–—]\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Extracts a display title and production year from a movie folder or file stem.
 */
export function parseMovieName(rawName: string): ParsedTitle {
  const name = stripBracketed(rawName).trim();

  const parenthesized = PARENTHESIZED_YEAR.exec(name);
  if (parenthesized) {
    const title = name.slice(0, parenthesized.index).trim();
    if (title) {
      return {
        title: cleanTitleTokens(tokenize(title)),
        year: Number(parenthesized[1]),
      };
    }
  }

  const tokens = tokenize(name);
  const titleTokens: string[] = [];
  let year: number | undefined;

  for (const token of tokens) {
    const bare = token.replace(/^\(|\)$/g, "");

    if (YEAR_PATTERN.test(bare)) {
      // A leading year is part of the title ("1917", "2012"); a later one is the
      // production year.
      if (titleTokens.length === 0) {
        titleTokens.push(bare);
        continue;
      }
      year = Number(bare);
      break;
    }

    // The first token is always kept: a title may legitimately be a word that
    // also appears in release metadata, and a title can never be empty.
    if (titleTokens.length > 0 && isReleaseToken(token)) break;
    titleTokens.push(token);
  }

  const title = cleanTitleTokens(titleTokens);
  return {
    title: title || cleanTitleTokens(tokens) || rawName.trim(),
    ...(year === undefined ? {} : { year }),
  };
}

const SEASON_FOLDER_PATTERNS: RegExp[] = [
  /^season[\s._-]*(\d{1,3})$/i,
  /^s(\d{1,3})$/i,
  /^sezon[\s._-]*(\d{1,3})$/i,
  /^series[\s._-]*(\d{1,3})$/i,
];

/**
 * Returns the season number for a season folder, `0` for a specials folder, or
 * `undefined` when the folder is not a season folder at all.
 */
export function parseSeasonFolder(rawName: string): number | undefined {
  const name = rawName.trim();
  if (/^(specials?|season\s*0|s00|özel)$/i.test(name)) return 0;

  for (const pattern of SEASON_FOLDER_PATTERNS) {
    const match = pattern.exec(name);
    if (match) return Number(match[1]);
  }
  return undefined;
}

interface EpisodeMarker {
  seasonNumber?: number;
  episodeNumber: number;
  endEpisodeNumber?: number;
  start: number;
  end: number;
}

function findEpisodeMarker(stem: string): EpisodeMarker | null {
  // S01E02, S01E02E03, S01E02-E03, S01E02-03
  const seasonEpisode =
    /\bs(\d{1,3})[\s._-]*e(\d{1,4})(?:[\s._-]*(?:e|-)\s*(\d{1,4}))?/i.exec(stem);
  if (seasonEpisode) {
    return {
      seasonNumber: Number(seasonEpisode[1]),
      episodeNumber: Number(seasonEpisode[2]),
      ...(seasonEpisode[3] === undefined
        ? {}
        : { endEpisodeNumber: Number(seasonEpisode[3]) }),
      start: seasonEpisode.index,
      end: seasonEpisode.index + seasonEpisode[0].length,
    };
  }

  // 1x02, 01x02-03
  const cross = /\b(\d{1,3})x(\d{1,4})(?:[\s._-]*(\d{1,4}))?\b/i.exec(stem);
  if (cross) {
    return {
      seasonNumber: Number(cross[1]),
      episodeNumber: Number(cross[2]),
      ...(cross[3] === undefined
        ? {}
        : { endEpisodeNumber: Number(cross[3]) }),
      start: cross.index,
      end: cross.index + cross[0].length,
    };
  }

  // "Season 1 Episode 2" spelled out.
  const spelled =
    /\bseason[\s._-]*(\d{1,3})[\s._-]*episode[\s._-]*(\d{1,4})\b/i.exec(stem);
  if (spelled) {
    return {
      seasonNumber: Number(spelled[1]),
      episodeNumber: Number(spelled[2]),
      start: spelled.index,
      end: spelled.index + spelled[0].length,
    };
  }

  // Bare "E02"/"Episode 2" — only meaningful when the season comes from the
  // containing folder.
  const bareEpisode = /\b(?:e|ep|episode)[\s._-]*(\d{1,4})\b/i.exec(stem);
  if (bareEpisode) {
    return {
      episodeNumber: Number(bareEpisode[1]),
      start: bareEpisode.index,
      end: bareEpisode.index + bareEpisode[0].length,
    };
  }

  return null;
}

function trimSeparators(value: string): string {
  return value.replace(/^[\s._\-–—]+|[\s._\-–—]+$/g, "").trim();
}

export interface ParseEpisodeOptions {
  /** Season taken from the containing folder, used when the name omits it. */
  folderSeasonNumber?: number;
  /** Series title taken from the series folder. */
  folderSeriesTitle?: string;
}

/**
 * Interprets an episode file stem, optionally anchored by its folder context.
 */
export function parseEpisodeName(
  rawStem: string,
  { folderSeasonNumber, folderSeriesTitle }: ParseEpisodeOptions = {},
): ParsedEpisode {
  const stem = stripBracketed(rawStem).trim();
  const marker = findEpisodeMarker(stem);

  if (!marker) {
    const parsed = parseMovieName(rawStem);
    return {
      ...parsed,
      ...(folderSeasonNumber === undefined
        ? {}
        : { seasonNumber: folderSeasonNumber }),
      ...(folderSeriesTitle === undefined
        ? {}
        : { seriesTitle: folderSeriesTitle }),
    };
  }

  const beforeMarker = trimSeparators(stem.slice(0, marker.start));
  const afterMarker = trimSeparators(stem.slice(marker.end));

  const seriesFromName = beforeMarker
    ? parseMovieName(beforeMarker).title
    : undefined;
  const seriesTitle = folderSeriesTitle ?? seriesFromName;

  // Everything after the marker up to the first release token is the episode
  // title. Scene names often place the group after a trailing dash.
  const episodeTitleTokens: string[] = [];
  for (const token of tokenize(afterMarker)) {
    if (isReleaseToken(token) || YEAR_PATTERN.test(token)) break;
    episodeTitleTokens.push(token);
  }
  const episodeTitle = cleanTitleTokens(episodeTitleTokens) || undefined;

  const seasonNumber = marker.seasonNumber ?? folderSeasonNumber;
  const endEpisodeNumber =
    marker.endEpisodeNumber !== undefined &&
    marker.endEpisodeNumber > marker.episodeNumber
      ? marker.endEpisodeNumber
      : undefined;

  return {
    title: episodeTitle ?? `Episode ${marker.episodeNumber}`,
    ...(seasonNumber === undefined ? {} : { seasonNumber }),
    episodeNumber: marker.episodeNumber,
    ...(endEpisodeNumber === undefined ? {} : { endEpisodeNumber }),
    ...(seriesTitle === undefined ? {} : { seriesTitle }),
    ...(episodeTitle === undefined ? {} : { episodeTitle }),
  };
}

/**
 * Sort titles drop a leading article and normalize case/diacritics so that
 * "The Matrix" and "Matrix, The" land next to each other in a listing.
 */
export function buildSortTitle(title: string): string {
  const normalized = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
  return normalized.replace(/^(the|a|an|le|la|les|el|los|das|der|die)\s+/, "");
}

export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Language suffix on an external subtitle: `Movie.en.forced.srt`. */
export function parseSubtitleSuffix(stem: string): {
  baseStem: string;
  language?: string;
  isForced: boolean;
  isDefault: boolean;
} {
  let working = stem;
  let isForced = false;
  let isDefault = false;
  let language: string | undefined;

  for (;;) {
    const match = /\.([A-Za-z]{2,3}|forced|default|sdh|cc)$/i.exec(working);
    if (!match) break;
    const token = (match[1] as string).toLowerCase();
    working = working.slice(0, match.index);

    if (token === "forced") {
      isForced = true;
      continue;
    }
    if (token === "default") {
      isDefault = true;
      continue;
    }
    if (token === "sdh" || token === "cc") continue;
    if (!language) language = token;
  }

  return {
    baseStem: working,
    ...(language === undefined ? {} : { language }),
    isForced,
    isDefault,
  };
}
