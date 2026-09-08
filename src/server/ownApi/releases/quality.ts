/**
 * Quality: the pair a person actually reasons about.
 *
 * Not one flat enum. The user's existing profiles name qualities as
 * `WEBDL-1080p`, `Bluray-2160p`, `Remux-2160p` — a source and a resolution,
 * chosen independently — and a single enum of every combination cannot express
 * "any 2160p" or "no WEBRip" without listing every member by hand.
 *
 * Ranking is deliberately *not* defined here. Whether Remux-1080p beats
 * WEBDL-2160p is a preference, and the profile that holds it says so by the
 * order it lists its qualities in. A global table here would be a second
 * opinion to reconcile with the user's.
 */
import type { ReleaseFacts, Resolution, Source } from "./releaseFacts";

/**
 * The source distinctions a profile draws.
 *
 * Coarser than the parser's, on purpose: `screener`, `cam` and `telesync` all
 * collapse to `cam` because no profile here distinguishes them, and a
 * distinction nothing consumes is a rank nobody can explain.
 */
export type QualitySource =
  | "remux"
  | "bluray"
  | "webdl"
  | "webrip"
  | "hdtv"
  | "dvd"
  | "cam"
  | "unknown";

export interface Quality {
  readonly source: QualitySource;
  readonly resolution: Resolution;
}

const SOURCE_MAP: Readonly<Record<Source, QualitySource>> = {
  remux: "remux",
  bluray: "bluray",
  webdl: "webdl",
  webrip: "webrip",
  hdtv: "hdtv",
  dvd: "dvd",
  screener: "cam",
  cam: "cam",
  telesync: "cam",
  unknown: "unknown",
};

/** `webdl-1080p`. Stable, lowercase, and what a profile stores. */
export function qualityId(quality: Quality): string {
  return `${quality.source}-${quality.resolution}`;
}

export function parseQualityId(id: string): Quality | undefined {
  const at = id.lastIndexOf("-");
  if (at <= 0) return undefined;
  const source = id.slice(0, at) as QualitySource;
  const resolution = id.slice(at + 1) as Resolution;
  if (!(source in SOURCE_RANK) || !RESOLUTION_ORDER.includes(resolution)) {
    return undefined;
  }
  return { source, resolution };
}

/**
 * What a release's facts amount to, as a quality.
 *
 * A DVD or SD source with no stated resolution is read as 480p, because
 * `dvd-unknown` would never match a profile entry and the release would be
 * rejected for saying something it did in fact say.
 */
export function qualityOf(facts: ReleaseFacts): Quality {
  const source = SOURCE_MAP[facts.source];
  let resolution = facts.resolution;
  if (resolution === "unknown" && (source === "dvd" || source === "cam")) {
    resolution = "480p";
  }
  return { source, resolution };
}

const RESOLUTION_ORDER: readonly Resolution[] = [
  "unknown",
  "480p",
  "576p",
  "720p",
  "1080i",
  "1080p",
  "2160p",
];

const SOURCE_RANK: Readonly<Record<QualitySource, number>> = {
  unknown: 0,
  cam: 1,
  dvd: 2,
  hdtv: 3,
  webrip: 4,
  webdl: 5,
  bluray: 6,
  remux: 7,
};

/**
 * A last-resort ordering, used only to break a tie between two qualities the
 * profile ranks equally — which happens when a profile allows a *group* of
 * qualities at one position, as the user's `x265` profiles do.
 *
 * Resolution dominates source: a person who asked for 2160p wants 2160p.
 */
export function intrinsicRank(quality: Quality): number {
  const resolution = RESOLUTION_ORDER.indexOf(quality.resolution);
  return (resolution < 0 ? 0 : resolution) * 10 + SOURCE_RANK[quality.source];
}

export function qualityLabel(quality: Quality): string {
  const source =
    quality.source === "unknown"
      ? "Unknown"
      : quality.source === "webdl"
        ? "WEB-DL"
        : quality.source === "webrip"
          ? "WEBRip"
          : quality.source === "hdtv"
            ? "HDTV"
            : quality.source === "dvd"
              ? "DVD"
              : quality.source === "cam"
                ? "CAM"
                : quality.source === "remux"
                  ? "Remux"
                  : "BluRay";
  return quality.resolution === "unknown"
    ? source
    : `${source} ${quality.resolution}`;
}
