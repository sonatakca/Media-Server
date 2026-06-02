import {
  getAllSeriesEpisodes,
  getItem,
  resetItemWatchedStatus,
} from "./jellyfinApi";
import type { JellyfinItem } from "./types";
import { WATCH_STATUS_CHANGED_EVENT } from "./watchedStatusActions";

interface IndexedEpisode {
  item: JellyfinItem;
  index: number;
}

function compareEpisodeOrder(
  left: IndexedEpisode,
  right: IndexedEpisode,
): number {
  const leftSeason = left.item.ParentIndexNumber;
  const rightSeason = right.item.ParentIndexNumber;

  if (
    typeof leftSeason === "number" &&
    typeof rightSeason === "number" &&
    leftSeason !== rightSeason
  ) {
    return leftSeason - rightSeason;
  }

  if (typeof leftSeason === "number" && typeof rightSeason !== "number") {
    return -1;
  }

  if (typeof leftSeason !== "number" && typeof rightSeason === "number") {
    return 1;
  }

  const leftEpisode = left.item.IndexNumber;
  const rightEpisode = right.item.IndexNumber;

  if (
    typeof leftEpisode === "number" &&
    typeof rightEpisode === "number" &&
    leftEpisode !== rightEpisode
  ) {
    return leftEpisode - rightEpisode;
  }

  if (typeof leftEpisode === "number" && typeof rightEpisode !== "number") {
    return -1;
  }

  if (typeof leftEpisode !== "number" && typeof rightEpisode === "number") {
    return 1;
  }

  return left.index - right.index;
}

async function getEpisodeSeriesId(item: JellyfinItem): Promise<string | null> {
  if (item.SeriesId) {
    return item.SeriesId;
  }

  const loadedItem = await getItem(item.Id);

  if (loadedItem.SeriesId) {
    return loadedItem.SeriesId;
  }

  const parentId = item.ParentId ?? loadedItem.ParentId;

  if (!parentId) {
    return null;
  }

  const parent = await getItem(parentId);

  return parent.SeriesId ?? parent.ParentId ?? null;
}

async function getItemsToClear(item: JellyfinItem): Promise<JellyfinItem[]> {
  if (item.Type !== "Episode") {
    return [item];
  }

  const seriesId = await getEpisodeSeriesId(item);

  if (!seriesId) {
    throw new Error("Could not determine the series to clear.");
  }

  const episodes = new Map<string, JellyfinItem>();

  for (const episode of await getAllSeriesEpisodes(seriesId)) {
    if (episode.Type === "Episode") {
      episodes.set(episode.Id, episode);
    }
  }

  if (episodes.size === 0) {
    throw new Error("Could not find any episodes to clear.");
  }

  if (!episodes.has(item.Id)) {
    episodes.set(item.Id, item);
  }

  return Array.from(episodes.values())
    .map((episode, index) => ({ item: episode, index }))
    .sort(compareEpisodeOrder)
    .map(({ item: episode }) => episode);
}

export async function clearContinueWatchingHistory(
  item: JellyfinItem,
): Promise<JellyfinItem> {
  const itemsToClear = await getItemsToClear(item);

  await Promise.all(
    itemsToClear.map((historyItem) => resetItemWatchedStatus(historyItem.Id)),
  );

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(WATCH_STATUS_CHANGED_EVENT, {
        detail: {
          itemIds: itemsToClear.map((historyItem) => historyItem.Id),
        },
      }),
    );
  }

  return itemsToClear[0] ?? item;
}
