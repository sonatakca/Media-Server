import type { JellyfinItem } from "./types";

export function getRouteForItem(item: JellyfinItem): string {
  if (item.CollectionType) {
    return `/library/${item.Id}`;
  }

  if (item.Type === "Series") {
    return `/library/${item.Id}`;
  }

  if (item.Type === "Season") {
    const seriesId = item.SeriesId ?? item.ParentId;

    if (seriesId) {
      return `/library/${item.Id}`;
    }

    return `/library/${item.Id}`;
  }

  return `/item/${item.Id}`;
}

export function getWatchRouteForItem(item: JellyfinItem): string {
  return `/watch/${encodeURIComponent(item.Id)}`;
}
