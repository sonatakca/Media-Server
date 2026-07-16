import type { JellyfinItem } from "./types";

function getNormalizedItemKind(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

export function shouldOpenPlaybackForItem(item: JellyfinItem): boolean {
  if (item.Type === "Episode") {
    return true;
  }

  if (
    item.Type === "Movie" ||
    item.Type === "Series" ||
    item.Type === "Season" ||
    item.Type === "BoxSet" ||
    item.CollectionType === "boxsets"
  ) {
    return false;
  }

  return item.MediaType === "Video";
}

export function shouldOpenReaderForItem(item: JellyfinItem): boolean {
  const type = getNormalizedItemKind(item.Type);
  const mediaType = getNormalizedItemKind(item.MediaType);

  return (
    type === "book" ||
    type === "document" ||
    mediaType === "book" ||
    mediaType === "document"
  );
}

export function getRouteForItem(item: JellyfinItem): string {
  if (item.Type === "BoxSet" || item.CollectionType === "boxsets") {
    return `/collections/${encodeURIComponent(item.Id)}`;
  }

  if (item.Type === "Movie") {
    return `/movies/${encodeURIComponent(item.Id)}`;
  }

  if (item.Type === "Series") {
    return `/shows/${encodeURIComponent(item.Id)}`;
  }

  if (item.Type === "Season") {
    return item.SeriesId
      ? `/shows/${encodeURIComponent(item.SeriesId)}/season/${encodeURIComponent(item.Id)}`
      : `/shows/season/${encodeURIComponent(item.Id)}`;
  }

  if (shouldOpenReaderForItem(item)) {
    return getReadRouteForItem(item);
  }

  if (shouldOpenPlaybackForItem(item)) {
    return getWatchRouteForItem(item);
  }

  return `/library/${encodeURIComponent(item.Id)}`;
}

export function getReadRouteForItem(item: JellyfinItem): string {
  return `/read/${encodeURIComponent(item.Id)}`;
}

export function getWatchRouteForItem(item: JellyfinItem): string {
  return `/watch/${encodeURIComponent(item.Id)}`;
}

export function getMediaOwnerRouteForItem(item: JellyfinItem): string {
  if (item.Type === "Episode") {
    const seriesId = item.SeriesId ?? item.ParentLogoItemId;

    if (seriesId) {
      return `/shows/${encodeURIComponent(seriesId)}`;
    }

    const seasonId = item.SeasonId ?? item.ParentId;

    if (seasonId) {
      return `/library/${seasonId}`;
    }
  }

  if (item.MediaType === "Video" && item.ParentId) {
    return `/library/${item.ParentId}`;
  }

  if (shouldOpenReaderForItem(item) && item.ParentId) {
    return `/library/${item.ParentId}`;
  }

  if (
    item.Type === "Movie" ||
    item.Type === "Series" ||
    item.Type === "Season"
  ) {
    return getRouteForItem(item);
  }

  return getRouteForItem(item);
}
