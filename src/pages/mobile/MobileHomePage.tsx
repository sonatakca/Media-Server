import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MotionReveal } from "../../components/MotionReveal";
import { ErrorMessage } from "../../components/ErrorMessage";
import { HomeHero } from "../../components/home/HomeHero";
import { HomeHeroSkeleton } from "../../components/home/HomeHeroSkeleton";
import { MobileMediaRow } from "../../components/mobile/MobileMediaRow";
import {
  PhoneHomeHero,
  PhoneHomeHeroSkeleton,
} from "../../components/mobile/PhoneHomeHero";
import { useIsPhoneView } from "../../hooks/useIsPhoneView";
import { useLanguage } from "../../i18n/LanguageContext";
import { getFavouriteItems, getLatestMediaItems } from "../../lib/mediaApi";
import { FAVOURITE_CHANGED_EVENT } from "../../lib/favouriteActions";
import { applyCuration, buildHomeCarouselPool } from "../../lib/curation";
import { buildLatestRow } from "../../lib/homeShelves";
import { useCataloguePools } from "../../hooks/useCataloguePools";
import { useHomeCuratedLists } from "../../hooks/useCuratedList";
import { getRouteForItem } from "../../lib/routes";
import { setSeoMetadata } from "../../lib/seo";
import { getSmartContinueWatchingItems } from "../../lib/smartContinueWatching";
import type { MediaItem } from "../../lib/types";
import { WATCH_STATUS_CHANGED_EVENT } from "../../lib/watchedStatusActions";
import { groupLatestMediaItems } from "../../lib/latestMedia";
import { useDevSkeletonMode } from "../../lib/devSkeletonMode";
import {
  getHomeLoadErrorMessage,
  removeContinueWatchingItem,
  replaceContinueWatchingItems,
} from "../home/homeModel";

type HomeRowLabelKey = "home.continueWatching" | "home.latestMedia";

interface MobileHomeData {
  continueWatching: MediaItem[];
  latestMedia: MediaItem[];
  favourites: MediaItem[];
}

interface RowWarning {
  labelKey: HomeRowLabelKey;
  message: string;
}

/**
 * The page while it has no data: the hero's own skeleton, built from the
 * hero's own frame, so nothing moves when the hero mounts over it, and the
 * rows' placeholders under it.
 */
function MobileHomeLoading({ isPhone }: { isPhone: boolean }) {
  return (
    <div className="layout-no-offset min-h-screen pb-[calc(5.75rem+env(safe-area-inset-bottom))]">
      {isPhone ? (
        <PhoneHomeHeroSkeleton />
      ) : (
        <div className="full-bleed">
          <HomeHeroSkeleton fit="mobile" />
        </div>
      )}

      <div className="mx-auto w-full px-4 pt-5">
        <div className="mb-8">
          <div className="shimmer mb-4 h-5 w-40 rounded-full" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="w-56 shrink-0 sm:w-64">
                <div className="shimmer aspect-video w-full rounded-xl" />
                <div className="mt-3 space-y-2">
                  <div className="shimmer h-4 w-3/4 rounded-full" />
                  <div className="shimmer h-3 w-1/2 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mb-8">
          <div className="shimmer mb-4 h-5 w-32 rounded-full" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="w-32 shrink-0 sm:w-40">
                <div className="shimmer aspect-[2/3] w-full rounded-xl" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MobileHomePage() {
  const { t } = useLanguage();
  const forceSkeletons = useDevSkeletonMode();
  // A phone keeps its poster card; a tablet gets the desktop's hero.
  const isPhone = useIsPhoneView();
  const [data, setData] = useState<MobileHomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowWarnings, setRowWarnings] = useState<RowWarning[]>([]);
  const curatedLists = useHomeCuratedLists();
  const pools = useCataloguePools();

  // The same pool, in the same hand-placed order, as the desktop hero.
  const heroItems = useMemo(() => {
    const pool = pools.loaded
      ? [...pools.movies, ...pools.series]
      : (data?.latestMedia ?? []);
    return applyCuration(buildHomeCarouselPool(pool), curatedLists.hero);
  }, [pools, data?.latestMedia, curatedLists.hero]);

  const refreshSmartContinueWatching = useCallback(async () => {
    const smartContinueItems = await getSmartContinueWatchingItems();

    setData((currentData) =>
      replaceContinueWatchingItems(currentData, smartContinueItems),
    );
  }, []);

  useEffect(() => {
    setSeoMetadata({
      title: `${t("common.home")} · Seyirlik`,
      canonicalPath: "/home",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let isMounted = true;

    async function loadHome() {
      setError(null);
      setRowWarnings([]);

      const [continueResult, latestResult, favouritesResult] =
        await Promise.allSettled([
          getSmartContinueWatchingItems(),
          getLatestMediaItems(),
          // A failed My List row must not take the rest of the home page with
          // it, so it is settled alongside the others and simply stays empty.
          getFavouriteItems(),
        ]);

      if (!isMounted) {
        return;
      }

      const warnings: RowWarning[] = [];

      if (continueResult.status === "rejected") {
        warnings.push({
          labelKey: "home.continueWatching",
          message: getHomeLoadErrorMessage(
            continueResult,
            t,
            t("home.someDataFailed"),
          ),
        });
      }

      if (latestResult.status === "rejected") {
        warnings.push({
          labelKey: "home.latestMedia",
          message: getHomeLoadErrorMessage(
            latestResult,
            t,
            t("home.someDataFailed"),
          ),
        });
      }

      setRowWarnings(warnings);

      // Stored raw: each Latest row carries its own ordering, so the curation
      // is applied per row at render rather than to the mixed pool here.
      setData({
        continueWatching:
          continueResult.status === "fulfilled" ? continueResult.value : [],
        latestMedia:
          latestResult.status === "fulfilled" ? latestResult.value : [],
        favourites:
          favouritesResult.status === "fulfilled" ? favouritesResult.value : [],
      });
    }

    void loadHome();

    return () => {
      isMounted = false;
    };
  }, [t]);

  useEffect(() => {
    const handleWatchStatusChanged = () => {
      void refreshSmartContinueWatching();
    };

    window.addEventListener(
      WATCH_STATUS_CHANGED_EVENT,
      handleWatchStatusChanged,
    );

    return () => {
      window.removeEventListener(
        WATCH_STATUS_CHANGED_EVENT,
        handleWatchStatusChanged,
      );
    };
  }, [refreshSmartContinueWatching]);

  useEffect(() => {
    const handleFavouriteChanged = () => {
      void getFavouriteItems()
        .then((favourites) => {
          setData((currentData) =>
            currentData ? { ...currentData, favourites } : currentData,
          );
        })
        .catch(() => undefined);
    };

    window.addEventListener(FAVOURITE_CHANGED_EVENT, handleFavouriteChanged);

    return () => {
      window.removeEventListener(
        FAVOURITE_CHANGED_EVENT,
        handleFavouriteChanged,
      );
    };
  }, []);

  if (forceSkeletons) {
    return <MobileHomeLoading isPhone={isPhone} />;
  }

  if (error) {
    return <ErrorMessage title={t("home.couldNotLoad")} message={error} />;
  }

  if (!data) {
    return <MobileHomeLoading isPhone={isPhone} />;
  }

  const handleClearContinueWatching = (clearedItem: MediaItem) => {
    setData((currentData) =>
      removeContinueWatchingItem(currentData, clearedItem.Id),
    );
    void refreshSmartContinueWatching();
  };

  /*
   * Each row draws from the whole library once the catalogue has arrived, and
   * from the server's Latest page until then. The fallback is what keeps the
   * first paint honest on a phone, where the full fetch is slowest.
   */
  const groupedLatestMedia = groupLatestMediaItems(data.latestMedia);
  const latestMediaGroups = {
    movies: buildLatestRow(
      pools.loaded ? pools.movies : groupedLatestMedia.movies,
      curatedLists.movies,
    ),
    shows: buildLatestRow(
      pools.loaded ? pools.series : groupedLatestMedia.shows,
      curatedLists.shows,
    ),
    books: buildLatestRow(
      pools.loaded ? pools.books : groupedLatestMedia.books,
      curatedLists.books,
    ),
  };
  return (
    <div className="layout-no-offset min-h-screen pb-[calc(5.75rem+env(safe-area-inset-bottom))]">
      {isPhone ? (
        <PhoneHomeHero
          items={heroItems}
          smartContinueItems={data.continueWatching}
        />
      ) : (
        <div className="full-bleed">
          <HomeHero items={heroItems} fit="mobile" trailers={false} />
        </div>
      )}

      <div className="mx-auto w-full px-4 pt-2">
        {rowWarnings.length > 0 ? (
          <div className="space-y-3 py-3">
            {rowWarnings.map((warning) => (
              <ErrorMessage
                key={`${warning.labelKey}-${warning.message}`}
                title={t("home.someDataFailed")}
                message={`${t(warning.labelKey)}: ${warning.message}`}
              />
            ))}
          </div>
        ) : null}

        <AnimatePresence>
          {data.continueWatching.length > 0 ? (
            <motion.div
              key="continue-watching"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8, height: 0 }}
              transition={{ duration: 0.4, ease: [0.25, 1, 0.5, 1] }}
            >
              <MobileMediaRow
                title={t("home.continueWatching")}
                items={data.continueWatching}
                getItemTo={getRouteForItem}
                emptyMessage={t("home.nothingInProgress")}
                showRestartWatching
                onClearContinueWatching={handleClearContinueWatching}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {data.favourites.length > 0 ? (
          <MotionReveal direction="up">
            <MobileMediaRow
              title={t("myList.title")}
              items={data.favourites}
              getItemTo={getRouteForItem}
            />
          </MotionReveal>
        ) : null}

        <MotionReveal direction="up">
          <MobileMediaRow
            title={t("home.latestAddedMovies")}
            items={latestMediaGroups.movies}
            getItemTo={getRouteForItem}
            emptyMessage={t("home.noLatestMovies")}
          />
        </MotionReveal>

        <MotionReveal direction="up">
          <MobileMediaRow
            title={t("home.latestAddedShows")}
            items={latestMediaGroups.shows}
            getItemTo={getRouteForItem}
            emptyMessage={t("home.noLatestShows")}
          />
        </MotionReveal>

        <MotionReveal direction="up">
          <MobileMediaRow
            title={t("home.latestAddedBooks")}
            items={latestMediaGroups.books}
            getItemTo={getRouteForItem}
            emptyMessage={t("home.noLatestBooks")}
          />
        </MotionReveal>
      </div>
    </div>
  );
}
