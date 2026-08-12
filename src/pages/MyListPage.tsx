import { useCallback, useEffect, useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { MediaCard } from "../components/MediaCard";
import { LibrarySkeleton } from "../components/Skeletons";
import { useLanguage } from "../i18n/LanguageContext";
import {
  FAVOURITE_CHANGED_EVENT,
  type FavouriteChangedEvent,
} from "../lib/favouriteActions";
import { getFavouriteItems } from "../lib/mediaApi";
import { getRouteForItem } from "../lib/routes";
import { setSeoMetadata } from "../lib/seo";
import type { MediaItem } from "../lib/types";

export function MyListPage() {
  const { t } = useLanguage();
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFavourites = useCallback(async () => {
    try {
      setError(null);
      setItems(await getFavouriteItems());
    } catch (reason) {
      console.warn("[Seyirlik My List] Could not load favourites", reason);
      setError(reason instanceof Error ? reason.message : String(reason));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    setSeoMetadata({
      title: `${t("myList.title")} · Seyirlik`,
      canonicalPath: "/my-list",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    void loadFavourites();
  }, [loadFavourites]);

  useEffect(() => {
    // Removing an item from its own card should drop it out of this grid
    // straight away rather than waiting for a refetch.
    const handleFavouriteChanged = (event: Event) => {
      const detail = (event as FavouriteChangedEvent).detail;

      if (!detail) {
        return;
      }

      setItems((currentItems) => {
        if (!currentItems) {
          return currentItems;
        }

        if (!detail.isFavourite) {
          return currentItems.filter((item) => item.Id !== detail.itemId);
        }

        return currentItems.some((item) => item.Id === detail.itemId)
          ? currentItems
          : currentItems;
      });

      if (detail.isFavourite) {
        void loadFavourites();
      }
    };

    window.addEventListener(FAVOURITE_CHANGED_EVENT, handleFavouriteChanged);

    return () => {
      window.removeEventListener(
        FAVOURITE_CHANGED_EVENT,
        handleFavouriteChanged,
      );
    };
  }, [loadFavourites]);

  if (!items) {
    return <LibrarySkeleton />;
  }

  return (
    <div className="pb-10">
      <h1 className="mb-6 text-2xl font-black tracking-tight text-white sm:text-3xl">
        {t("myList.title")}
      </h1>

      {error ? (
        <ErrorMessage title={t("myList.couldNotLoad")} message={error} />
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-6 py-16 text-center">
          <p className="text-base font-black text-white">{t("myList.empty")}</p>
          <p className="mt-2 text-sm font-semibold text-white/50">
            {t("myList.emptyHint")}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((item, index) => (
            <MediaCard
              key={item.Id}
              item={item}
              to={getRouteForItem(item)}
              layout="grid"
              index={index}
            />
          ))}
        </div>
      )}
    </div>
  );
}
