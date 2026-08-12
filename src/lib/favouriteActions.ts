import { setItemFavourite } from "./mediaApi";
import type { MediaItem } from "./types";

export const FAVOURITE_CHANGED_EVENT = "seyirlik:favourite-changed";

export interface FavouriteChangedDetail {
  itemId: string;
  isFavourite: boolean;
}

export type FavouriteChangedEvent = CustomEvent<FavouriteChangedDetail>;

export function isItemFavourite(item: MediaItem): boolean {
  return Boolean(item.UserData?.IsFavorite);
}

export function withFavouriteUserData(
  item: MediaItem,
  isFavourite: boolean,
): MediaItem {
  return {
    ...item,
    UserData: {
      ...(item.UserData ?? {}),
      IsFavorite: isFavourite,
    },
  };
}

function emitFavouriteChanged(detail: FavouriteChangedDetail): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<FavouriteChangedDetail>(FAVOURITE_CHANGED_EVENT, {
      detail,
    }),
  );
}

/**
 * Writes the new favourite state and announces it, so every surface showing the
 * same item (cards, hero, details, the My List row) settles on one answer
 * without each of them refetching.
 */
export async function toggleItemFavourite(
  item: MediaItem,
  nextIsFavourite: boolean,
): Promise<MediaItem> {
  await setItemFavourite(item.Id, nextIsFavourite);

  emitFavouriteChanged({ itemId: item.Id, isFavourite: nextIsFavourite });

  return withFavouriteUserData(item, nextIsFavourite);
}
