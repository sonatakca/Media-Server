import { getContinueWatchingItems, getNextUpEpisodes } from "./jellyfinApi";
import type { JellyfinItem } from "./types";
import { DEFAULT_COMPLETION_THRESHOLD, isItemCompleted } from "./watchStatus";

export { DEFAULT_COMPLETION_THRESHOLD };

function getActivityTimestamp(item: JellyfinItem): number {
  const dates = [
    item.UserData?.LastPlayedDate,
    item.LastPlayedDate,
    item.DatePlayed,
    item.DateCreated,
    item.PremiereDate,
  ];

  for (const date of dates) {
    if (!date) {
      continue;
    }

    const timestamp = Date.parse(date);

    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }

  return 0;
}

function pushUniqueItem(
  items: JellyfinItem[],
  seenItemIds: Set<string>,
  item: JellyfinItem,
): void {
  if (seenItemIds.has(item.Id)) {
    return;
  }

  seenItemIds.add(item.Id);
  items.push(item);
}

export function isSmartContinueCompleted(
  item: JellyfinItem,
  completionThreshold = DEFAULT_COMPLETION_THRESHOLD,
): boolean {
  return isItemCompleted(item, completionThreshold);
}

export function buildSmartContinueWatchingItems(
  resumeItems: JellyfinItem[],
  nextUpItems: JellyfinItem[],
  options?: { completionThreshold?: number },
): JellyfinItem[] {
  const completionThreshold =
    options?.completionThreshold ?? DEFAULT_COMPLETION_THRESHOLD;

  const seenItemIds = new Set<string>();
  const seenSeriesIds = new Set<string>();
  const smartItems: JellyfinItem[] = [];

  for (const item of nextUpItems) {
    if (item.Type !== "Episode" || !item.SeriesId) {
      continue;
    }

    const isSeasonOne = item.ParentIndexNumber === 1;
    const isEpisodeOne = item.IndexNumber === 1;
    const isNotStarted = (item.UserData?.PlaybackPositionTicks ?? 0) === 0;

    if (isSeasonOne && isEpisodeOne && isNotStarted) {
      continue;
    }

    seenSeriesIds.add(item.SeriesId);

    if (isSmartContinueCompleted(item, completionThreshold)) {
      continue;
    }

    pushUniqueItem(smartItems, seenItemIds, item);
  }

  for (const item of resumeItems) {
    if (isSmartContinueCompleted(item, completionThreshold)) {
      continue;
    }

    if (item.Type === "Episode" && item.SeriesId) {
      if (seenSeriesIds.has(item.SeriesId)) {
        continue;
      }

      seenSeriesIds.add(item.SeriesId);
      pushUniqueItem(smartItems, seenItemIds, item);
      continue;
    }

    pushUniqueItem(smartItems, seenItemIds, item);
  }

  return smartItems.sort(
    (left, right) => getActivityTimestamp(right) - getActivityTimestamp(left),
  );
}

export async function getSmartContinueWatchingItems(options?: {
  completionThreshold?: number;
}): Promise<JellyfinItem[]> {
  const [resumeItems, nextUpItems] = await Promise.all([
    getContinueWatchingItems().catch(() => [] as JellyfinItem[]),
    getNextUpEpisodes().catch(() => [] as JellyfinItem[]),
  ]);

  return buildSmartContinueWatchingItems(resumeItems, nextUpItems, options);
}
