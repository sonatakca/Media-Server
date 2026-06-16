import { getDisplayTitle } from "./format";
import { getAllMovieAndSeriesItems, getItem } from "./jellyfinApi";
import type { JellyfinItem } from "./types";

export interface ResolvedMetadataTarget {
  item: JellyfinItem;
  isExtra: boolean;
  ownerItem?: JellyfinItem;
  metadataItem: JellyfinItem;
  artworkItem: JellyfinItem;
  tmdbTitle: string;
  tmdbYear?: number;
  tmdbId?: string;
}

const TRAILERS_FOLDER_NAME = "trailers";
const GENERIC_EXTRA_TITLES = new Set(["trailer", "trailers", "fragman"]);

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getPathSegments(pathValue: string | undefined): string[] {
  return pathValue?.split(/[\\/]+/).filter(Boolean) ?? [];
}

function findTrailersSegmentIndex(pathValue: string | undefined): number {
  return getPathSegments(pathValue).findIndex(
    (segment) => segment.toLocaleLowerCase("en-US") === TRAILERS_FOLDER_NAME,
  );
}

export function getTrailerOwnerFolderName(
  pathValue: string | undefined,
): string | null {
  const segments = getPathSegments(pathValue);
  const trailersIndex = findTrailersSegmentIndex(pathValue);

  if (trailersIndex <= 0) {
    return null;
  }

  return segments[trailersIndex - 1] || null;
}

function parseFolderTitleAndYear(folderName: string): {
  title: string;
  year?: number;
} {
  const yearMatch = folderName.match(/\((\d{4})\)\s*$/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  const title = yearMatch
    ? folderName.slice(0, yearMatch.index).trim()
    : folderName.trim();

  return {
    title: title || folderName,
    year: Number.isInteger(year) ? year : undefined,
  };
}

function getTmdbProviderIdFromItem(item: JellyfinItem): string | undefined {
  const providerIds = item.ProviderIds ?? {};
  return providerIds.Tmdb ?? providerIds.TMDB ?? providerIds.tmdb ?? undefined;
}

export function isJellyfinExtraItem(item: JellyfinItem): boolean {
  if (typeof item.ExtraType === "string" && item.ExtraType.trim()) {
    return true;
  }

  if (findTrailersSegmentIndex(item.Path) >= 0) {
    return true;
  }

  return false;
}

function isUsableMetadataOwner(
  item: JellyfinItem,
  childItem: JellyfinItem,
): boolean {
  if (item.Id === childItem.Id || isJellyfinExtraItem(item)) {
    return false;
  }

  return item.Type === "Movie" || item.Type === "Series";
}

async function resolveOwnerFromRelationships(
  item: JellyfinItem,
): Promise<JellyfinItem | undefined> {
  const candidateIds = Array.from(
    new Set([item.ParentId, item.SeriesId].filter(Boolean)),
  ) as string[];

  for (const candidateId of candidateIds) {
    try {
      const candidate = await getItem(candidateId);

      if (isUsableMetadataOwner(candidate, item)) {
        return candidate;
      }
    } catch {
      // Relationship fields are best-effort. The path fallback below handles
      // servers that do not expose a usable parent for extras.
    }
  }

  return undefined;
}

async function resolveOwnerFromTrailerPath(
  item: JellyfinItem,
): Promise<JellyfinItem | undefined> {
  const ownerFolderName = getTrailerOwnerFolderName(item.Path);

  if (!ownerFolderName) {
    return undefined;
  }

  const { title, year } = parseFolderTitleAndYear(ownerFolderName);
  const normalizedOwnerFolder = normalizeText(ownerFolderName);
  const normalizedTitle = normalizeText(title);
  const candidates = await getAllMovieAndSeriesItems();

  const pathMatch = candidates.find((candidate) =>
    getPathSegments(candidate.Path).some(
      (segment) => normalizeText(segment) === normalizedOwnerFolder,
    ),
  );

  if (pathMatch) {
    return pathMatch;
  }

  return candidates.find((candidate) => {
    const candidateTitles = [
      candidate.Name,
      candidate.SortName,
      candidate.OriginalTitle,
      getDisplayTitle(candidate),
    ]
      .filter((value): value is string => Boolean(value))
      .map(normalizeText);

    const titleMatches = candidateTitles.includes(normalizedTitle);
    const yearMatches =
      year === undefined || candidate.ProductionYear === undefined
        ? true
        : candidate.ProductionYear === year;

    return titleMatches && yearMatches;
  });
}

export async function resolveMetadataTarget(
  item: JellyfinItem,
): Promise<ResolvedMetadataTarget> {
  const isExtra = isJellyfinExtraItem(item);
  const ownerItem = isExtra
    ? ((await resolveOwnerFromRelationships(item)) ??
      (await resolveOwnerFromTrailerPath(item).catch(() => undefined)))
    : undefined;
  const metadataItem = ownerItem ?? item;
  const ownerFolderName = isExtra ? getTrailerOwnerFolderName(item.Path) : null;
  const rawTitle = ownerItem
    ? getDisplayTitle(ownerItem)
    : (ownerFolderName ?? getDisplayTitle(item));
  const normalizedRawTitle = normalizeText(rawTitle);
  const tmdbTitle =
    isExtra && GENERIC_EXTRA_TITLES.has(normalizedRawTitle) ? "" : rawTitle;

  return {
    item,
    isExtra,
    ownerItem,
    metadataItem,
    artworkItem: metadataItem,
    tmdbTitle,
    tmdbYear: metadataItem.ProductionYear,
    tmdbId: getTmdbProviderIdFromItem(metadataItem),
  };
}

export function getMetadataTargetCacheKey(
  target: ResolvedMetadataTarget,
): string {
  return target.isExtra && target.ownerItem
    ? `trailer:${target.item.Id}:owner:${target.ownerItem.Id}`
    : `item:${target.item.Id}`;
}
