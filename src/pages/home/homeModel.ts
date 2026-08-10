import type { MediaItem } from "../../lib/types";

interface HomeDataWithContinueWatching {
  continueWatching: MediaItem[];
}

export function getHomeLoadErrorMessage(
  result: PromiseRejectedResult,
  fallback: string,
): string {
  return result.reason instanceof Error ? result.reason.message : fallback;
}

export function replaceContinueWatchingItems<
  T extends HomeDataWithContinueWatching,
>(currentData: T | null, items: MediaItem[]): T | null {
  return currentData
    ? {
        ...currentData,
        continueWatching: items,
      }
    : currentData;
}

export function removeContinueWatchingItem<
  T extends HomeDataWithContinueWatching,
>(currentData: T | null, itemId: string): T | null {
  return currentData
    ? {
        ...currentData,
        continueWatching: currentData.continueWatching.filter(
          (item) => item.Id !== itemId,
        ),
      }
    : currentData;
}
