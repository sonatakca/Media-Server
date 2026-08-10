import type { ArtworkCandidate, ArtworkKind } from "../../lib/artworkApi";
import type { MediaItem } from "../../lib/types";
import type { TranslationKey } from "../../i18n/translations";

/**
 * Pure decisions behind the artwork override page, kept out of the component so
 * the filtering and grouping can be tested without a browser.
 */

export const ARTWORK_KINDS: ArtworkKind[] = ["poster", "backdrop", "logo"];

/** The stored image type each provider set replaces. */
export const STORED_TYPE_BY_KIND: Record<ArtworkKind, string> = {
  poster: "primary",
  backdrop: "backdrop",
  logo: "logo",
};

/** `null` means artwork with no text, which TMDB reports as a blank language. */
export type ImageLanguageFilter = "all" | "en" | "tr" | "none";

export function getKindLabelKey(kind: ArtworkKind): TranslationKey {
  return `tmdbArtwork.kind.${kind}` as TranslationKey;
}

export function getKindDescriptionKey(kind: ArtworkKind): TranslationKey {
  return `tmdbArtwork.kind.${kind}Description` as TranslationKey;
}

export function getLanguageLabelKey(language: string | null): TranslationKey {
  if (language === "en") return "tmdbArtwork.language.english";
  if (language === "tr") return "tmdbArtwork.language.turkish";
  return "tmdbArtwork.language.none";
}

/**
 * Only titles can carry their own artwork. Seasons and episodes inherit it from
 * the series, so offering them here would promise something the server refuses.
 */
export function isArtworkEligible(item: MediaItem): boolean {
  return item.Type === "Movie" || item.Type === "Series";
}

export function filterTitles(
  items: MediaItem[],
  search: string,
): MediaItem[] {
  const query = search.trim().toLowerCase();
  if (!query) return items;

  return items.filter((item) => {
    const haystack = [
      item.Name,
      item.OriginalTitle,
      item.ProductionYear?.toString(),
      item.Id,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

export function matchesLanguageFilter(
  candidate: ArtworkCandidate,
  filter: ImageLanguageFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "none") return candidate.language === null;
  return candidate.language === filter;
}

/**
 * A popular film can have several hundred posters, which is a grid nobody
 * scrolls and several megabytes of thumbnails nobody looks at. The server ranks
 * candidates by provider vote, so taking the first few keeps the ones worth
 * seeing; the language filter re-draws from the whole set rather than from what
 * survived the cap.
 */
export const MAX_VISIBLE_PER_KIND = 24;

export function selectCandidates(
  candidates: ArtworkCandidate[],
  kind: ArtworkKind,
  filter: ImageLanguageFilter,
  limit: number = MAX_VISIBLE_PER_KIND,
): ArtworkCandidate[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.kind === kind && matchesLanguageFilter(candidate, filter),
    )
    .slice(0, limit);
}

export function countCandidates(
  candidates: ArtworkCandidate[],
  kind: ArtworkKind,
  filter: ImageLanguageFilter,
): number {
  return candidates.filter(
    (candidate) =>
      candidate.kind === kind && matchesLanguageFilter(candidate, filter),
  ).length;
}

export function isKindLocked(
  lockedTypes: readonly string[],
  kind: ArtworkKind,
): boolean {
  return lockedTypes.includes(STORED_TYPE_BY_KIND[kind]);
}

/**
 * Whether a stored image exists for a kind. A locked type always has one; an
 * automatic type may not, when the provider had nothing to offer.
 */
export function hasStoredArtwork(
  current: ReadonlyArray<{ imageType: string; imageIndex: number }>,
  kind: ArtworkKind,
): boolean {
  return current.some(
    (image) =>
      image.imageType === STORED_TYPE_BY_KIND[kind] && image.imageIndex === 0,
  );
}

export function formatDimensions(
  width: number | null,
  height: number | null,
): string {
  return width && height ? `${width} × ${height}` : "—";
}

export type StatusTone = "idle" | "busy" | "success" | "error";

export interface ActionStatus {
  tone: StatusTone;
  message: string;
}

export function getStatusClasses(tone: StatusTone): string {
  if (tone === "error") return "text-rose-300";
  if (tone === "success") return "text-emerald-300";
  if (tone === "busy") return "text-sky-300";
  return "text-white/45";
}

/**
 * The server distinguishes "never identified" from "cannot have artwork", and
 * the page should say which rather than showing a bare failure.
 */
export function getArtworkErrorKey(code: unknown): TranslationKey {
  if (code === "PROVIDER_ID_MISSING") {
    return "tmdbArtwork.itemMetadataRequiresMatch";
  }
  if (code === "ARTWORK_NOT_APPLICABLE") {
    return "tmdbArtwork.artworkNotApplicable";
  }
  return "tmdbArtwork.couldNotLoadImages";
}
