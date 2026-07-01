import type { JellyfinItem } from "./types";

export function getRouteForItem(item: JellyfinItem): string {
  if (item.Type === "BoxSet" || item.CollectionType === "boxsets") {
    return `/library/${item.Id}`;
  }

  if (item.Type === "Series" || item.Type === "Movie") {
    return `/library/${item.Id}`;
  }

  if (item.Type === "Season") {
    return `/library/${item.Id}`;
  }

  if (item.Type === "Episode" || item.MediaType === "Video") {
    return getWatchRouteForItem(item);
  }

  return `/library/${item.Id}`;
}

export function getWatchRouteForItem(item: JellyfinItem): string {
  return `/watch/${encodeURIComponent(item.Id)}`;
}

export function getMediaOwnerRouteForItem(item: JellyfinItem): string {
  if (item.Type === "Episode") {
    const seriesId = item.SeriesId ?? item.ParentLogoItemId;

    if (seriesId) {
      return `/library/${seriesId}`;
    }

    const seasonId = item.SeasonId ?? item.ParentId;

    if (seasonId) {
      return `/library/${seasonId}`;
    }
  }

  if (item.MediaType === "Video" && item.ParentId) {
    return `/library/${item.ParentId}`;
  }

  if (
    item.Type === "Movie" ||
    item.Type === "Series" ||
    item.Type === "Season"
  ) {
    return `/library/${item.Id}`;
  }

  return getRouteForItem(item);
}
