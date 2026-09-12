/**
 * The administrator's library: every movie and show, including the ones with
 * nothing to play yet. Browse pages never see a title without a source; this
 * is where those are managed.
 */
import { ownApiClient } from "../api/ownApi/client";

export type LibraryTitleKind = "movie" | "series" | "book";

export interface HoldingFacts {
  status: string;
  hasMedia: boolean;
  downloading: number;
  importing: number;
  processing: number;
  sizeBytes: number;
  resolution: number | null;
  audioLanguages: string[];
  subtitleLanguages: string[];
  pendingSubtitles: string[];
  files: number;
  trickplayFiles: number;
}

export interface LibraryTitle extends HoldingFacts {
  id: string;
  kind: LibraryTitleKind;
  title: string;
  year: number | null;
  desired: boolean;
  tmdbId: string | null;
  imdbId: string | null;
  episodeCount: number;
  availableEpisodeCount: number;
  artwork: TitleArtwork;
}

export interface TitleArtwork {
  coverTag: string | null;
  logoTag: string | null;
  logoLayout: { x: number; y: number; width: number; shadow: number } | null;
  /** No cover, or its file is gone; TMDB can fill it in. */
  missing: boolean;
}

export interface LibraryEpisode extends HoldingFacts {
  id: string | null;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: string | null;
  mediaFileId: string | null;
  fileName: string | null;
  monitored: boolean;
  hasThumb: boolean;
  stillUrl: string | null;
}

export interface LibraryTitleDetail extends LibraryTitle {
  mediaFileId: string | null;
  fileName: string | null;
  seasons: Array<{
    id: string | null;
    seasonNumber: number;
    episodes: LibraryEpisode[];
  }>;
  catalogueComplete: boolean;
}

export interface TitleRemovalReport {
  itemId: string;
  title: string;
  folder: string | null;
  filesRemoved: number;
  downloadsCancelled: number;
  leftovers: string[];
}

export async function listLibraryTitles(
  kind: LibraryTitleKind,
): Promise<LibraryTitle[]> {
  const { items } = await ownApiClient.request<{ items: LibraryTitle[] }>(
    `/library/titles?${new URLSearchParams({ kind })}`,
  );
  return items;
}

export function getLibraryTitle(itemId: string): Promise<LibraryTitleDetail> {
  return ownApiClient.request<LibraryTitleDetail>(
    `/library/titles/${encodeURIComponent(itemId)}`,
  );
}

/** Irreversible. The server refuses unless `confirmTitle` repeats the title exactly. */
export function removeLibraryTitle(
  itemId: string,
  confirmTitle: string,
): Promise<TitleRemovalReport> {
  return ownApiClient.request<TitleRemovalReport>(
    `/library/titles/${encodeURIComponent(itemId)}/remove`,
    { method: "POST", body: { confirmTitle } },
  );
}

/** Looks for subtitles for a film, or for every episode file of a show or season. */
export function requestTitleSubtitles(
  itemId: string,
  language: string,
): Promise<{ files: number; queued: number }> {
  return ownApiClient.request(
    `/subtitles/items/${encodeURIComponent(itemId)}`,
    {
      method: "POST",
      body: { language },
    },
  );
}

/** Fetches TMDB artwork for every matched title whose cover is missing. */
export function importMissingArtwork(): Promise<{ queued: number }> {
  return ownApiClient.request("/library/titles/artwork", {
    method: "POST",
    body: {},
  });
}

/**
 * Trickplay for a film, an episode, a season or a whole show. Without `force`
 * only what has no sheets yet is generated.
 */
export function generateTrickplay(
  itemId: string,
  force = false,
): Promise<{ queued: number; alreadyGenerated: number; notReady: number }> {
  return ownApiClient.request(
    `/admin/items/${encodeURIComponent(itemId)}/trickplay`,
    { method: "POST", body: { force } },
  );
}

/**
 * The colour a title is shown in.
 *
 * Green when there is something to play, purple while a download or import is
 * moving, red when it is wanted and absent, grey when nobody asked for it.
 */
export type HoldingTone =
  | "held"
  | "downloading"
  | "wanted"
  | "absent"
  | "unaired";

export function toneOf(
  facts: Pick<
    HoldingFacts,
    "hasMedia" | "downloading" | "importing" | "status"
  >,
  wanted: boolean,
): HoldingTone {
  if (facts.hasMedia) return "held";
  if (facts.downloading > 0 || facts.importing > 0) return "downloading";
  if (facts.status === "unaired") return "unaired";
  return wanted ? "wanted" : "absent";
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** power;
  return `${value >= 100 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}
