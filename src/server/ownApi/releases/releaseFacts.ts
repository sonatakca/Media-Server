/**
 * What a release title appears to describe.
 *
 * Facts only. Whether 2160p WEB-DL beats 1080p BluRay is a policy question
 * answered by a quality profile, and mixing the two here would mean the parser
 * had to change every time somebody's preferences did.
 *
 * Every field is optional or explicitly `"unknown"`. A release name is written
 * by a stranger to no standard, so the honest answer to most questions is
 * often "it does not say" — and a parser that invents `SDR` for a title that
 * simply never mentioned HDR has told a lie the scoring layer cannot detect.
 */

export type Resolution =
  | "2160p"
  | "1080p"
  | "1080i"
  | "720p"
  | "576p"
  | "480p"
  | "unknown";

export type Source =
  | "remux"
  | "bluray"
  | "webdl"
  | "webrip"
  | "hdtv"
  | "dvd"
  | "screener"
  | "cam"
  | "telesync"
  | "unknown";

export type VideoCodec =
  | "hevc"
  | "avc"
  | "av1"
  | "vc1"
  | "mpeg2"
  | "xvid"
  | "divx"
  | "unknown";

/** Present only for what the title actually claims. */
export type HdrFormat = "hdr10plus" | "hdr10" | "dolbyvision" | "hlg" | "sdr";

export type AudioCodec =
  | "truehd"
  | "dtsx"
  | "dtshd"
  | "dts"
  | "eac3"
  | "ac3"
  | "aac"
  | "flac"
  | "opus"
  | "mp3"
  | "pcm"
  | "unknown";

export interface EpisodeRange {
  readonly season: number;
  /** Empty for a whole-season pack. */
  readonly episodes: readonly number[];
}

export interface ReleaseFacts {
  /** Byte-for-byte as the indexer supplied it. Never rewritten. */
  readonly rawTitle: string;
  /** Punctuation collapsed, tags stripped: for matching, not for display. */
  readonly normalizedTitle: string;
  readonly year?: number;

  readonly kind: "movie" | "episode" | "season" | "unknown";
  /** One entry per season the title names; more than one is a multi-season pack. */
  readonly episodeRanges: readonly EpisodeRange[];
  readonly isSeasonPack: boolean;
  readonly absoluteEpisodes: readonly number[];

  readonly resolution: Resolution;
  readonly source: Source;
  readonly videoCodec: VideoCodec;
  readonly bitDepth?: number;
  /** In the order the title names them; empty when it says nothing. */
  readonly hdr: readonly HdrFormat[];
  readonly edition: readonly string[];

  readonly audioCodec: AudioCodec;
  /** 7.1 becomes 8, 5.1 becomes 6, stereo 2. Absent when unstated. */
  readonly audioChannels?: number;
  readonly audioFeatures: readonly string[];
  readonly languages: readonly string[];

  readonly releaseGroup?: string;
  readonly proper: boolean;
  readonly repack: boolean;
  readonly real: boolean;
  /** `PROPER v2` and `REPACK3` both raise this above zero. */
  readonly revision: number;
  readonly internal: boolean;
  readonly streamingService?: string;
}
