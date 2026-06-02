import {
  getAllSeriesEpisodes,
  getItem,
  getSeasonEpisodes,
  markItemWatchedStatus,
  resetItemWatchedStatus,
} from "./jellyfinApi";
import type { JellyfinItem } from "./types";

export const WATCH_STATUS_CHANGED_EVENT = "seyirlik:watch-status-changed";

function withResetUserData(item: JellyfinItem): JellyfinItem {
  return {
    ...item,
    UserData: {
      ...(item.UserData ?? {}),
      PlaybackPositionTicks: 0,
      PlayedPercentage: 0,
      Played: false,
    },
  };
}

function withWatchedUserData(item: JellyfinItem): JellyfinItem {
  return {
    ...item,
    UserData: {
      ...(item.UserData ?? {}),
      PlaybackPositionTicks:
        item.RunTimeTicks ?? item.UserData?.PlaybackPositionTicks ?? 0,
      PlayedPercentage: 100,
      Played: true,
      LastPlayedDate: new Date().toISOString(),
    },
  };
}

function emitWatchStatusChanged(items: JellyfinItem[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(WATCH_STATUS_CHANGED_EVENT, {
      detail: {
        itemIds: items.map((item) => item.Id),
      },
    }),
  );
}

async function resetItems(items: JellyfinItem[]): Promise<JellyfinItem[]> {
  await Promise.all(items.map((item) => resetItemWatchedStatus(item.Id)));

  const resetItems = items.map(withResetUserData);
  emitWatchStatusChanged(resetItems);
  return resetItems;
}

async function markItems(items: JellyfinItem[]): Promise<JellyfinItem[]> {
  await Promise.all(items.map((item) => markItemWatchedStatus(item.Id)));

  const watchedItems = items.map(withWatchedUserData);
  emitWatchStatusChanged(watchedItems);
  return watchedItems;
}

export async function removeWatchedStatusForItem(
  item: JellyfinItem,
): Promise<JellyfinItem[]> {
  return resetItems([item]);
}

export async function removeWatchedStatusForSeason(
  seriesId: string,
  seasonId: string,
): Promise<JellyfinItem[]> {
  const episodes = await getSeasonEpisodes(seriesId, seasonId);
  return resetItems(episodes.filter((item) => item.Type === "Episode"));
}

export async function removeWatchedStatusForShow(
  seriesId: string,
): Promise<JellyfinItem[]> {
  const episodes = await getAllSeriesEpisodes(seriesId);
  return resetItems(episodes.filter((item) => item.Type === "Episode"));
}

export async function markWatchedStatusForItem(
  item: JellyfinItem,
): Promise<JellyfinItem[]> {
  return markItems([item]);
}

export async function markWatchedStatusForSeason(
  seriesId: string,
  seasonId: string,
): Promise<JellyfinItem[]> {
  const episodes = await getSeasonEpisodes(seriesId, seasonId);
  return markItems(episodes.filter((item) => item.Type === "Episode"));
}

export async function markWatchedStatusForShow(
  seriesId: string,
): Promise<JellyfinItem[]> {
  const episodes = await getAllSeriesEpisodes(seriesId);
  return markItems(episodes.filter((item) => item.Type === "Episode"));
}

export async function reloadItemAfterWatchedStatusChange(
  item: JellyfinItem,
): Promise<JellyfinItem> {
  return getItem(item.Id).catch(() => withResetUserData(item));
}
