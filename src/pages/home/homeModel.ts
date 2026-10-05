import type { TranslationKey } from "../../i18n/translations";
import type { MediaItem } from "../../lib/types";
import { describeErrorDetail } from "../../lib/userFacingError";

interface HomeDataWithContinueWatching {
  continueWatching: MediaItem[];
}

export function getHomeLoadErrorMessage(
  result: PromiseRejectedResult,
  t: (key: TranslationKey) => string,
  fallback: string,
): string {
  return describeErrorDetail(result.reason, t) || fallback;
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
