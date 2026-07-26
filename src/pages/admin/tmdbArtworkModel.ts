import type { TranslationKey } from "../../i18n/translations";
import { formatTemplate, getDisplayTitle } from "../../lib/format";
import {
  getBackdropImageUrl,
  getLogoImageUrl,
  getPrimaryImageUrl,
  getThumbImageUrl,
} from "../../lib/jellyfinApi";
import type {
  TmdbArtworkImage,
  TmdbArtworkKind,
  TmdbEpisodeThumbnailLanguage,
  TmdbMediaType,
  TmdbSearchResult,
} from "../../lib/tmdbArtworkApi";
import type { JellyfinItem } from "../../lib/types";

export type ActionState = "idle" | "loading" | "success" | "error";
export type Translate = (key: TranslationKey) => string;
export type EpisodeSeasonFilter = "all" | number;
export type ArtworkPickerKind = Exclude<TmdbArtworkKind, "landscape">;

export interface ActionResult {
  state: ActionState;
  message: string;
}

export const ARTWORK_KINDS: ArtworkPickerKind[] = [
  "poster",
  "backdrop",
  "logo",
];

export const TARGET_FILE_BY_KIND: Record<TmdbArtworkKind, string> = {
  poster: "folder.jpg",
  backdrop: "backdrop.jpg",
  landscape: "landscape.jpg",
  logo: "logo.png",
};

export const EPISODE_THUMBNAIL_LANGUAGES: TmdbEpisodeThumbnailLanguage[] = [
  "en",
  "tr",
  null,
];

export function createEmptyResult(): ActionResult {
  return {
    state: "idle",
    message: "",
  };
}

export function getTypeLabel(item: JellyfinItem, t: Translate) {
  if (item.Type === "Movie") return t("common.movie");
  if (item.Type === "Series") return t("common.series");
  return item.Type ?? t("common.item");
}

export function getMediaTypeForItem(item: JellyfinItem): TmdbMediaType {
  return item.Type === "Series" ? "tv" : "movie";
}

export function getTmdbIdFromItem(item: JellyfinItem): number | null {
  const providerIds = item.ProviderIds ?? {};
  const rawTmdbId =
    providerIds.Tmdb ?? providerIds.TMDB ?? providerIds.tmdb ?? null;
  const parsed = rawTmdbId ? Number(rawTmdbId) : NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function createTmdbResultFromProvider(
  item: JellyfinItem,
): TmdbSearchResult | null {
  const tmdbId = getTmdbIdFromItem(item);

  if (!tmdbId) {
    return null;
  }

  return {
    id: tmdbId,
    mediaType: getMediaTypeForItem(item),
    title: getDisplayTitle(item),
    originalTitle: item.OriginalTitle ?? null,
    overview: item.Overview ?? null,
    year: item.ProductionYear ?? null,
    date: item.PremiereDate ?? null,
    posterPath: null,
    backdropPath: null,
    posterPreviewUrl: null,
    backdropPreviewUrl: null,
    voteAverage: null,
    popularity: null,
  };
}

export function getKindLabel(kind: TmdbArtworkKind, t: Translate): string {
  if (kind === "poster") return t("tmdbArtwork.kind.poster");
  if (kind === "backdrop") return t("tmdbArtwork.kind.backdrop");
  if (kind === "landscape") return t("tmdbArtwork.kind.landscape");
  return t("tmdbArtwork.kind.logo");
}

export function getKindDescription(
  kind: TmdbArtworkKind,
  t: Translate,
): string {
  if (kind === "poster") return t("tmdbArtwork.kind.posterDescription");
  if (kind === "backdrop") return t("tmdbArtwork.kind.backdropDescription");
  if (kind === "landscape") return t("tmdbArtwork.kind.landscapeDescription");
  return t("tmdbArtwork.kind.logoDescription");
}

export function getCurrentArtworkTag(
  item: JellyfinItem,
  kind: TmdbArtworkKind,
): string | null {
  if (kind === "poster") return item.ImageTags?.Primary ?? null;
  if (kind === "backdrop") return item.BackdropImageTags?.[0] ?? null;
  if (kind === "landscape") return item.ImageTags?.Thumb ?? null;
  return item.ImageTags?.Logo ?? null;
}

export function getCurrentArtworkUrl(
  item: JellyfinItem,
  kind: TmdbArtworkKind,
): string | null {
  const tag = getCurrentArtworkTag(item, kind);

  if (!tag) {
    return null;
  }

  if (kind === "poster") return getPrimaryImageUrl(item.Id, tag, 440);
  if (kind === "backdrop") return getBackdropImageUrl(item.Id, tag, 900);
  if (kind === "landscape") return getThumbImageUrl(item.Id, tag, 900);
  return getLogoImageUrl(item.Id, tag, 700);
}

export function getCurrentArtworkPreviewUrl(
  url: string | null,
  refreshToken: number,
): string | null {
  if (!url) {
    return null;
  }

  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}preview=${refreshToken}`;
}

export function getLanguageLabel(
  language: TmdbArtworkImage["language"],
  t: Translate,
) {
  if (language === "en") return t("tmdbArtwork.language.english");
  if (language === "tr") return t("tmdbArtwork.language.turkish");
  return t("tmdbArtwork.language.none");
}

export function formatDimensions(
  image: TmdbArtworkImage,
  t: Translate,
): string {
  if (!image.width || !image.height) {
    return t("common.unknown");
  }

  return `${image.width} x ${image.height}`;
}

export function getEpisodeMetadataKey(
  seasonNumber: number | null | undefined,
  episodeNumber: number | null | undefined,
): string | null {
  if (
    typeof seasonNumber !== "number" ||
    !Number.isFinite(seasonNumber) ||
    typeof episodeNumber !== "number" ||
    !Number.isFinite(episodeNumber)
  ) {
    return null;
  }

  return `${seasonNumber}:${episodeNumber}`;
}

export function getEpisodeLabel(item: JellyfinItem, t: Translate): string {
  if (
    typeof item.ParentIndexNumber === "number" &&
    typeof item.IndexNumber === "number"
  ) {
    return formatTemplate(t("media.seasonEpisodeNumber"), {
      seasonNumber: item.ParentIndexNumber,
      episodeNumber: item.IndexNumber,
    });
  }

  if (typeof item.IndexNumber === "number") {
    return formatTemplate(t("media.episodeNumber"), {
      number: item.IndexNumber,
    });
  }

  return item.Name;
}

export function getResultSubtitle(
  result: TmdbSearchResult,
  t: Translate,
): string {
  return [
    result.mediaType === "tv" ? t("common.series") : t("common.movie"),
    result.year?.toString(),
    result.voteAverage ? result.voteAverage.toFixed(1) : undefined,
  ]
    .filter(Boolean)
    .join(" / ");
}

export function getLoadedMetadataText(
  value: string | null | undefined,
  fallback: string,
): string {
  return value?.trim() || fallback;
}

export function getStatusClasses(state: ActionState): string {
  if (state === "error") {
    return "border-red-400/20 bg-red-400/10 text-red-100";
  }

  if (state === "success") {
    return "border-emerald-400/20 bg-emerald-400/10 text-emerald-100";
  }

  return "border-white/10 bg-white/[0.06] text-white/62";
}

export function getSearchableText(item: JellyfinItem): string {
  return [
    item.Name,
    item.SortName,
    item.OriginalTitle,
    item.Type,
    item.ProductionYear,
    ...(item.Genres ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
