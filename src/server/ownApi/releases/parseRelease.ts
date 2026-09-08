/**
 * Reads a release title into facts.
 *
 * The shape of the problem: a release name is written by a stranger to no
 * standard, so almost every rule here has a counter-example somewhere. Two
 * consequences run through the whole file.
 *
 * First, order matters. `2160p` must be claimed before a bare `2160`, `WEB-DL`
 * before `WEB`, `DTS-HD` before `DTS`, `HDR10+` before `HDR10` before `HDR`.
 * The longest, most specific token wins, because the alternative is a title
 * that says `DTS-HD MA` being recorded as plain `DTS`.
 *
 * Second, silence is not evidence. A title that never mentions HDR gets an
 * empty `hdr`, not `SDR`; a title with no group gets no group. Inventing a
 * default here would put a fact into the record that no later layer could tell
 * apart from one the release actually claimed.
 */
import type {
  AudioCodec,
  EpisodeRange,
  HdrFormat,
  ReleaseFacts,
  Resolution,
  Source,
  VideoCodec,
} from "./releaseFacts";

/** Separators a scene name uses interchangeably. */
const SEPARATOR = /[.\s_]+/g;

function tokenize(title: string): string {
  // Brackets and parentheses become spaces so `[Group]` and `(2019)` split off,
  // but hyphens survive: they carry `WEB-DL`, `DTS-HD` and `-GROUP`.
  return ` ${title.replace(/[[\]{}()]/g, " ").replace(SEPARATOR, " ")} `;
}

const RESOLUTIONS: ReadonlyArray<readonly [Resolution, RegExp]> = [
  ["2160p", /\b(?:2160p|4k|uhd(?=\s|$)|3840x2160)\b/i],
  ["1080i", /\b1080i\b/i],
  ["1080p", /\b(?:1080p|1920x1080)\b/i],
  ["720p", /\b(?:720p|1280x720)\b/i],
  ["576p", /\b576[pi]\b/i],
  ["480p", /\b(?:480[pi]|ntsc)\b/i],
];

/**
 * Ordered most specific first.
 *
 * `REMUX` is treated as its own source rather than a modifier on BluRay: it is
 * the distinction a profile most often cares about, and a title saying
 * `UHD.BluRay.REMUX` should not collapse into the same value as one saying
 * `BluRay`.
 */
const SOURCES: ReadonlyArray<readonly [Source, RegExp]> = [
  ["remux", /\bremux\b/i],
  ["webdl", /\b(?:web[-\s]?dl|webdl|amzn|nf|dsnp|hmax|atvp|itunes)\b/i],
  ["webrip", /\b(?:web[-\s]?rip|webrip|web)\b/i],
  ["bluray", /\b(?:blu[-\s]?ray|bluray|bdrip|brrip|bd25|bd50|bdremux)\b/i],
  ["hdtv", /\b(?:hdtv|pdtv|dsr|sdtv)\b/i],
  ["dvd", /\b(?:dvdrip|dvd[59]?|ntsc[-\s]?dvd|pal[-\s]?dvd)\b/i],
  ["screener", /\b(?:dvdscr|bdscr|screener|scr)\b/i],
  ["telesync", /\b(?:telesync|hdts|\bts\b)\b/i],
  ["cam", /\b(?:camrip|hdcam|\bcam\b)\b/i],
];

const VIDEO_CODECS: ReadonlyArray<readonly [VideoCodec, RegExp]> = [
  ["hevc", /\b(?:hevc|[hx][-\s]?265|h265)\b/i],
  ["avc", /\b(?:avc|[hx][-\s]?264|h264)\b/i],
  ["av1", /\bav1\b/i],
  ["vc1", /\bvc[-\s]?1\b/i],
  ["mpeg2", /\bmpeg[-\s]?2\b/i],
  ["xvid", /\bxvid\b/i],
  ["divx", /\bdivx\b/i],
];

const HDR_FORMATS: ReadonlyArray<readonly [HdrFormat, RegExp]> = [
  ["hdr10plus", /\b(?:hdr10\+|hdr10plus|hdrplus)/i],
  ["dolbyvision", /\b(?:dolby[-\s]?vision|dovi|\bdv\b)\b/i],
  ["hdr10", /\bhdr10\b(?!\+)/i],
  ["hlg", /\bhlg\b/i],
  ["sdr", /\bsdr\b/i],
];

const AUDIO_CODECS: ReadonlyArray<readonly [AudioCodec, RegExp]> = [
  ["truehd", /\b(?:true[-\s]?hd|truehd)\b/i],
  ["dtsx", /\bdts[-\s]?x\b/i],
  ["dtshd", /\bdts[-\s]?hd(?:[-\s]?ma)?\b/i],
  [
    "eac3",
    /\b(?:e[-\s]?ac[-\s]?3|eac3|ddp\d*|dd\+|dolby[-\s]?digital[-\s]?plus)\b/i,
  ],
  ["ac3", /\b(?:ac[-\s]?3|dd\d*(?![p+a-z])|dolby[-\s]?digital)\b/i],
  ["dts", /\bdts\b/i],
  ["flac", /\bflac\b/i],
  ["opus", /\bopus\b/i],
  ["pcm", /\b(?:lpcm|pcm)\b/i],
  ["aac", /\baac\d*\b/i],
  ["mp3", /\bmp3\b/i],
];

const EDITIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Extended", /\bextended(?:[-\s]?(?:cut|edition|version))?\b/i],
  ["Director's Cut", /\b(?:director'?s?[-\s]?cut|dc)\b/i],
  ["IMAX", /\bimax\b/i],
  ["Theatrical", /\btheatrical(?:[-\s]?cut)?\b/i],
  ["Remastered", /\bremaster(?:ed)?\b/i],
  ["Unrated", /\bunrated\b/i],
  ["Uncut", /\buncut\b/i],
  ["Criterion", /\bcriterion\b/i],
  ["Special Edition", /\bspecial[-\s]?edition\b/i],
  ["Ultimate Edition", /\bultimate[-\s]?edition\b/i],
  ["Final Cut", /\bfinal[-\s]?cut\b/i],
];

const STREAMING: ReadonlyArray<readonly [string, RegExp]> = [
  ["Amazon", /\b(?:amzn|amazon)\b/i],
  ["Netflix", /\b(?:nf|netflix)\b/i],
  ["Disney+", /\b(?:dsnp|dsny|disney)\b/i],
  ["Max", /\b(?:hmax|max)\b/i],
  ["Apple TV+", /\b(?:atvp|appletv)\b/i],
  ["Hulu", /\bhulu\b/i],
  ["Paramount+", /\b(?:pmtp|paramount)\b/i],
  ["Peacock", /\bpcok\b/i],
];

const LANGUAGES: ReadonlyArray<readonly [string, RegExp]> = [
  ["English", /\b(?:english|eng)\b/i],
  ["Turkish", /\b(?:turkish|turkce|türkçe|tur)\b/i],
  ["French", /\b(?:french|vostfr|truefrench)\b/i],
  ["German", /\b(?:german|deutsch|ger)\b/i],
  ["Spanish", /\b(?:spanish|castellano|latino|esp)\b/i],
  ["Italian", /\b(?:italian|ita)\b/i],
  ["Japanese", /\b(?:japanese|jpn)\b/i],
  ["Korean", /\b(?:korean|kor)\b/i],
  ["Russian", /\b(?:russian|rus)\b/i],
  ["Multi", /\bmulti\b/i],
  ["Dual Audio", /\bdual[-\s]?audio\b/i],
];

const AUDIO_FEATURES: ReadonlyArray<readonly [string, RegExp]> = [
  ["Atmos", /\batmos\b/i],
  ["DTS:X", /\bdts[-\s]?x\b/i],
  ["Auro-3D", /\bauro[-\s]?3d\b/i],
];

function firstMatch<T>(
  tokens: string,
  table: ReadonlyArray<readonly [T, RegExp]>,
  fallback: T,
): T {
  for (const [value, pattern] of table) {
    if (pattern.test(tokens)) return value;
  }
  return fallback;
}

function allMatches<T>(
  tokens: string,
  table: ReadonlyArray<readonly [T, RegExp]>,
): T[] {
  const found: T[] = [];
  for (const [value, pattern] of table) {
    if (pattern.test(tokens) && !found.includes(value)) found.push(value);
  }
  return found;
}

/**
 * Seasons and episodes, in the several shapes releases use.
 *
 * Returns the ranges plus the index in the raw title where the first one
 * started, which is where the series name stops.
 */
function parseEpisodes(title: string): {
  ranges: EpisodeRange[];
  isSeasonPack: boolean;
  titleEndsAt: number;
} {
  const ranges: EpisodeRange[] = [];
  let titleEndsAt = -1;
  let isSeasonPack = false;

  const note = (index: number) => {
    if (titleEndsAt === -1 || index < titleEndsAt) titleEndsAt = index;
  };

  // S01E02, S01E02E03, S01E02-E04, S01E02-04
  const combined =
    /\bS(\d{1,3})\s?((?:[EX]\d{1,4}(?:\s?-\s?[EX]?\d{1,4})?)+)\b/gi;
  for (const match of title.matchAll(combined)) {
    const season = Number(match[1]);
    const episodes: number[] = [];
    const part = match[2] ?? "";
    const spans = part.matchAll(/[EX](\d{1,4})(?:\s?-\s?[EX]?(\d{1,4}))?/gi);
    for (const span of spans) {
      const from = Number(span[1]);
      const to = span[2] === undefined ? from : Number(span[2]);
      // A descending or absurd span is a title we do not understand; take the
      // endpoints rather than materialising a huge list from a typo.
      if (to < from || to - from > 200) {
        episodes.push(from);
        if (span[2] !== undefined) episodes.push(to);
        continue;
      }
      for (let episode = from; episode <= to; episode += 1)
        episodes.push(episode);
    }
    ranges.push({
      season,
      episodes: [...new Set(episodes)].sort((a, b) => a - b),
    });
    note(match.index ?? 0);
  }

  if (ranges.length === 0) {
    // 1x02, 1x02-03
    for (const match of title.matchAll(
      /\b(\d{1,2})x(\d{1,3})(?:\s?-\s?(\d{1,3}))?\b/gi,
    )) {
      const season = Number(match[1]);
      const from = Number(match[2]);
      const to = match[3] === undefined ? from : Number(match[3]);
      const episodes: number[] = [];
      for (let episode = from; episode <= Math.max(from, to); episode += 1) {
        episodes.push(episode);
      }
      ranges.push({ season, episodes });
      note(match.index ?? 0);
    }
  }

  if (ranges.length === 0) {
    // Whole-season and multi-season packs: S01, S01-S03, Season 2, Series 2
    const packs = title.matchAll(
      /\bS(?:eason[.\s_]?|eries[.\s_]?)?(\d{1,3})(?:[.\s_]?-[.\s_]?S?(?:eason[.\s_]?)?(\d{1,3}))?\b(?![.\s_]?[EX]\d)/gi,
    );
    for (const match of packs) {
      const from = Number(match[1]);
      const to = match[2] === undefined ? from : Number(match[2]);
      if (to < from || to - from > 60) continue;
      for (let season = from; season <= to; season += 1) {
        ranges.push({ season, episodes: [] });
      }
      isSeasonPack = true;
      note(match.index ?? 0);
    }
  }

  if (ranges.some((range) => range.episodes.length === 0)) isSeasonPack = true;
  // "Complete" alone is not a season number, but it does confirm a pack.
  if (ranges.length > 0 && /\bcomplete\b/i.test(title)) isSeasonPack = true;

  return { ranges, isSeasonPack, titleEndsAt };
}

/** `- GROUP` at the very end, or `[GROUP]`, which is the anime convention. */
function parseGroup(rawTitle: string): string | undefined {
  const bracketed = rawTitle.match(/^\[([^\]]{1,40})\]/);
  if (bracketed?.[1] && !/^\d+$/.test(bracketed[1])) return bracketed[1].trim();

  const withoutContainer = rawTitle.replace(/\.(mkv|mp4|avi|ts|m2ts)$/i, "");
  const trailing = withoutContainer.match(
    /-\s?([A-Za-z0-9][A-Za-z0-9_.@]{0,24})$/,
  );
  if (!trailing?.[1]) return undefined;
  const candidate = trailing[1].trim();
  // A trailing number is part of the name — "Cloud Atlas - 2012" has no group.
  if (/^\d+$/.test(candidate)) return undefined;
  // Nor is a bare quality token that happened to follow a hyphen.
  if (/^(?:dl|hd|ma|x|e|dts|rip|cut)$/i.test(candidate)) return undefined;
  return candidate;
}

/**
 * The year, and where in the title it was found.
 *
 * The *last* plausible year before the metadata starts, not the first: "2012"
 * in "2012 2009 1080p" is the film's name and 2009 is its year, and "Blade
 * Runner 2049 2017" is the same shape. Reading left to right gets both
 * backwards. 2160 is excluded because it is a resolution far more often than
 * it is a year.
 */
function parseYear(
  title: string,
  titleEndsAt: number,
): { year?: number; index: number } {
  const limit = titleEndsAt <= 0 ? title.length : titleEndsAt;
  const searchArea = title.slice(0, limit);
  /*
   * Bounded by the present. "Blade Runner 2049" has no second year token, so
   * 2049 would otherwise be read as the film's year — but no release exists
   * for a film that has not come out. 2160 is excluded separately because it
   * is a resolution far more often than it is a year.
   */
  const latest = new Date().getUTCFullYear() + 1;
  const matches = [...searchArea.matchAll(/\b(19\d{2}|20\d{2})\b/g)].filter(
    (match) => Number(match[1]) !== 2160 && Number(match[1]) <= latest,
  );
  const last = matches[matches.length - 1];
  if (!last) return { index: -1 };
  return { year: Number(last[1]), index: last.index ?? -1 };
}

const METADATA_START =
  /\b(?:S\d{1,3}(?:[EX]\d{1,4})?|\d{3,4}[pi]|4k|uhd|remux|blu[-\s]?ray|bluray|web[-\s]?dl|webrip|hdtv|dvdrip|complete|season|series)\b/i;

function normalizeTitle(
  rawTitle: string,
  titleEndsAt: number,
  yearIndex: number,
): string {
  /*
   * The name ends at whichever comes first: the year this release claims, the
   * season marker, or the first piece of non-year metadata. Cutting at the
   * first year-shaped token instead would truncate "Blade Runner 2049" to
   * "Blade Runner", and cutting at nothing would leave "2012" as the whole
   * string for a film actually called 2012.
   */
  let head = rawTitle.replace(/^\[[^\]]{1,40}\]\s*/, "");
  const offset = rawTitle.length - head.length;
  const candidates: number[] = [];
  if (titleEndsAt > 0) candidates.push(titleEndsAt - offset);
  if (yearIndex > 0) candidates.push(yearIndex - offset);
  const meta = head.search(METADATA_START);
  if (meta > 0) candidates.push(meta);
  const cut = candidates.filter((value) => value > 0).sort((a, b) => a - b)[0];
  if (cut !== undefined) head = head.slice(0, cut);
  return head
    .replace(/[[\]{}()]/g, " ")
    .replace(SEPARATOR, " ")
    .replace(/[-–—:]+$/g, " ")
    .trim()
    .toLowerCase();
}

function parseAudioChannels(tokens: string): number | undefined {
  // Not `\b(\d)`: "DDP5.1" tokenizes to "DDP5 1", and there is no word
  // boundary between P and 5. Guarding on neighbouring digits instead keeps
  // "1080p 2160p" from being read as a channel layout.
  const match = tokens.match(/(?<!\d)(\d)[.\s](\d)(?!\d)/);
  if (!match) return undefined;
  const main = Number(match[1]);
  const low = Number(match[2]);
  // 7.1 and 5.1 are layouts; 2.0 is stereo. Anything else is not a layout.
  if (main > 9 || low > 2) return undefined;
  return main + low;
}

function parseRevision(tokens: string): number {
  const explicit = tokens.match(/\b(?:proper|repack|real)\s?v?(\d)\b/i);
  if (explicit?.[1]) return Number(explicit[1]);
  const versioned = tokens.match(/\bv(\d)\b/i);
  if (versioned?.[1]) return Number(versioned[1]);
  return /\b(?:proper|repack|real)\b/i.test(tokens) ? 1 : 0;
}

/**
 * Reads one release title.
 *
 * Never throws: an unreadable title yields facts that are mostly `unknown`,
 * because a candidate that cannot be understood must still be describable to
 * the layer that will reject it.
 */
export function parseRelease(rawTitle: string): ReleaseFacts {
  const title = typeof rawTitle === "string" ? rawTitle : "";
  const tokens = tokenize(title);
  const { ranges, isSeasonPack, titleEndsAt } = parseEpisodes(title);

  const absoluteEpisodes: number[] = [];
  if (ranges.length === 0) {
    // Anime convention: "Series Name - 137 [1080p]". Only when nothing else
    // named a season, and only for a hyphen-separated bare number.
    const match = title.match(/\s-\s(\d{1,4})(?:v\d)?\s/);
    if (match?.[1]) absoluteEpisodes.push(Number(match[1]));
  }

  const hasEpisodes = ranges.some((range) => range.episodes.length > 0);
  const kind: ReleaseFacts["kind"] = hasEpisodes
    ? "episode"
    : ranges.length > 0
      ? "season"
      : absoluteEpisodes.length > 0
        ? "episode"
        : title.trim() === ""
          ? "unknown"
          : "movie";

  const { year, index: yearIndex } = parseYear(title, titleEndsAt);
  const bitDepth = tokens.match(/\b(8|10|12)\s?bits?\b/i);
  const group = parseGroup(title);

  return {
    rawTitle: title,
    normalizedTitle: normalizeTitle(title, titleEndsAt, yearIndex),
    ...(year === undefined ? {} : { year }),
    kind,
    episodeRanges: ranges,
    isSeasonPack,
    absoluteEpisodes,
    resolution: firstMatch(tokens, RESOLUTIONS, "unknown"),
    source: firstMatch(tokens, SOURCES, "unknown"),
    videoCodec: firstMatch(tokens, VIDEO_CODECS, "unknown"),
    ...(bitDepth?.[1] === undefined ? {} : { bitDepth: Number(bitDepth[1]) }),
    hdr: allMatches(tokens, HDR_FORMATS),
    edition: allMatches(tokens, EDITIONS),
    audioCodec: firstMatch(tokens, AUDIO_CODECS, "unknown"),
    ...(parseAudioChannels(tokens) === undefined
      ? {}
      : { audioChannels: parseAudioChannels(tokens)! }),
    audioFeatures: allMatches(tokens, AUDIO_FEATURES),
    languages: allMatches(tokens, LANGUAGES),
    ...(group === undefined ? {} : { releaseGroup: group }),
    proper: /\bproper\d*\b/i.test(tokens),
    repack: /\brepack\d*\b/i.test(tokens),
    real: /\breal\d*\b/i.test(tokens),
    revision: parseRevision(tokens),
    internal: /\binternal\b/i.test(tokens),
    ...(firstMatch(tokens, STREAMING, undefined as string | undefined) ===
    undefined
      ? {}
      : {
          streamingService: firstMatch(
            tokens,
            STREAMING,
            undefined as string | undefined,
          )!,
        }),
  };
}
