import { useCallback, useEffect, useState } from "react";
import {
  FAVOURITE_CHANGED_EVENT,
  isItemFavourite,
  toggleItemFavourite,
  type FavouriteChangedEvent,
} from "../lib/favouriteActions";
import type { MediaItem } from "../lib/types";

interface FavouriteState {
  isFavourite: boolean;
  isSaving: boolean;
  didFail: boolean;
  toggle: () => void;
}

/**
 * Keeps one item's favourite state in sync across every surface that renders
 * it. The toggle is optimistic and rolls back if the write fails, so the
 * button never lies about what the server stored.
 */
export function useFavouriteState(item: MediaItem | null): FavouriteState {
  const itemId = item?.Id ?? null;
  const serverIsFavourite = item ? isItemFavourite(item) : false;
  const [isFavourite, setIsFavourite] = useState(serverIsFavourite);
  const [isSaving, setIsSaving] = useState(false);
  const [didFail, setDidFail] = useState(false);

  useEffect(() => {
    setIsFavourite(serverIsFavourite);
    setIsSaving(false);
    setDidFail(false);
  }, [itemId, serverIsFavourite]);

  useEffect(() => {
    if (!itemId) {
      return;
    }

    const handleFavouriteChanged = (event: Event) => {
      const detail = (event as FavouriteChangedEvent).detail;

      if (detail?.itemId === itemId) {
        setIsFavourite(detail.isFavourite);
      }
    };

    window.addEventListener(FAVOURITE_CHANGED_EVENT, handleFavouriteChanged);

    return () => {
      window.removeEventListener(
        FAVOURITE_CHANGED_EVENT,
        handleFavouriteChanged,
      );
    };
  }, [itemId]);

  const toggle = useCallback(() => {
    if (!item || isSaving) {
      return;
    }

    const nextIsFavourite = !isFavourite;

    setIsFavourite(nextIsFavourite);
    setIsSaving(true);
    setDidFail(false);

    void toggleItemFavourite(item, nextIsFavourite)
      .then(() => {
        setIsSaving(false);
      })
      .catch((error: unknown) => {
        console.warn("[Seyirlik Favourites] Could not save favourite", error);
        setIsFavourite(!nextIsFavourite);
        setIsSaving(false);
        setDidFail(true);
      });
  }, [isFavourite, isSaving, item]);

  return { isFavourite, isSaving, didFail, toggle };
}
