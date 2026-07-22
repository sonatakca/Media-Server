import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Search, SlidersHorizontal } from "lucide-react";
import { useParams } from "react-router-dom";
import { BackButton } from "../../components/BackButton";
import { ErrorMessage } from "../../components/ErrorMessage";
import { MobileMediaCard } from "../../components/mobile/MobileMediaCard";
import { SeriesLibraryDetails } from "../../components/SeriesLibraryDetails";
import { WatchedIndicator } from "../../components/WatchedIndicator";
import { WatchedStatusButton } from "../../components/WatchedStatusButton";
import {
  glassControlBase,
  glassInputControl,
} from "../../components/ui/glassControlStyles";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { getDisplayTitle } from "../../lib/format";
import {
  getBoxSetItems,
  getBackdropImageUrl,
  getItem,
  getItemsForLibrary,
  getLogoImageUrl,
  getPrimaryImageUrl,
  getSeasonEpisodes,
  getSeriesSeasons,
  getTopLevelItemsForLibrary,
} from "../../lib/jellyfinApi";
import {
  loadCollectionPosterChildrenMap,
  type CollectionPosterChildrenMap,
} from "../../lib/collectionPoster";
import { sortCollectionItemsForWatching } from "../../lib/collectionUtils";
import { setPageTitle } from "../../lib/pageTitle";
import { preloadMediaPlayback } from "../../lib/playbackPreload";
import { getRouteForItem } from "../../lib/routes";
import type { JellyfinItem } from "../../lib/types";
import { isItemCompleted } from "../../lib/watchStatus";
import type { LibraryPageProps } from "../libraryPageTypes";
import { preloadPlayerPage } from "../PlayerPage";
import { useDevSkeletonMode } from "../../lib/devSkeletonMode";
import {
  MovieLibrarySkeleton,
  ShowLibrarySkeleton,
} from "../../components/Skeletons";

type LibraryFallbackTitleKey =
  | "common.series"
  | "format.season"
  | "library.library";

interface LibraryData {
  library?: JellyfinItem;
  fallbackTitleKey?: LibraryFallbackTitleKey;
  items: JellyfinItem[];
  selectableSeasons: JellyfinItem[];
  collectionPosterChildrenById: CollectionPosterChildrenMap;
}

function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}

function countLabel(
  count: number,
  singularKey: TranslationKey,
  pluralKey: TranslationKey,
  t: (key: TranslationKey) => string,
): string {
  return count === 1 ? t(singularKey) : formatTemplate(t(pluralKey), { count });
}

function compareNames(left: JellyfinItem, right: JellyfinItem): number {
  return (left.SortName ?? left.Name).localeCompare(
    right.SortName ?? right.Name,
    undefined,
    { numeric: true },
  );
}

function getLibraryBackdropUrl(
  library: JellyfinItem | undefined,
  items: JellyfinItem[],
): string {
  if (library?.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(library.Id, library.BackdropImageTags[0], 1000);
  }

  const itemWithBackdrop = items.find(
    (item) =>
      Boolean(item.BackdropImageTags?.[0]) ||
      Boolean(item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]),
  );

  if (itemWithBackdrop?.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(
      itemWithBackdrop.Id,
      itemWithBackdrop.BackdropImageTags[0],
      1000,
    );
  }

  if (
    itemWithBackdrop?.ParentBackdropItemId &&
    itemWithBackdrop.ParentBackdropImageTags?.[0]
  ) {
    return getBackdropImageUrl(
      itemWithBackdrop.ParentBackdropItemId,
      itemWithBackdrop.ParentBackdropImageTags[0],
      1000,
    );
  }

  if (library?.ImageTags?.Primary) {
    return getPrimaryImageUrl(library.Id, library.ImageTags.Primary, 760);
  }

  const itemWithPrimary = items.find((item) => item.ImageTags?.Primary);

  return itemWithPrimary?.ImageTags?.Primary
    ? getPrimaryImageUrl(
        itemWithPrimary.Id,
        itemWithPrimary.ImageTags.Primary,
        760,
      )
    : "";
}

function getSortNumber(item: JellyfinItem): number {
  return item.IndexNumber ?? item.ProductionYear ?? 9999;
}

function compareDates(leftDate?: string, rightDate?: string): number {
  return (
    Date.parse(leftDate ?? "9999-12-31") - Date.parse(rightDate ?? "9999-12-31")
  );
}

function sortItems(
  left: JellyfinItem,
  right: JellyfinItem,
  sortBy: "name" | "year" | "latest",
): number {
  if (left.Type === "Season" && right.Type === "Season") {
    return (
      getSortNumber(left) - getSortNumber(right) || compareNames(left, right)
    );
  }

  if (left.Type === "Episode" && right.Type === "Episode") {
    return (
      (left.ParentIndexNumber ?? 0) - (right.ParentIndexNumber ?? 0) ||
      getSortNumber(left) - getSortNumber(right) ||
      compareDates(left.PremiereDate, right.PremiereDate) ||
      compareNames(left, right)
    );
  }

  if (sortBy === "year") {
    return (right.ProductionYear ?? 0) - (left.ProductionYear ?? 0);
  }

  if (sortBy === "latest") {
    return (
      Date.parse(right.DateCreated ?? right.PremiereDate ?? "1970-01-01") -
      Date.parse(left.DateCreated ?? left.PremiereDate ?? "1970-01-01")
    );
  }

  return compareNames(left, right);
}

function isWholeWatchedScope(
  library: JellyfinItem | undefined,
  items: JellyfinItem[],
): boolean {
  if (library && isItemCompleted(library)) {
    return true;
  }

  const watchableItems = items.filter(
    (item) =>
      item.Type === "Episode" ||
      item.Type === "Season" ||
      item.Type === "Movie" ||
      item.MediaType === "Video",
  );

  return watchableItems.length > 0 && watchableItems.every(isItemCompleted);
}

function isWatchableScopeItem(item: JellyfinItem): boolean {
  return (
    item.Type === "Episode" ||
    item.Type === "Season" ||
    item.Type === "Movie" ||
    item.MediaType === "Video"
  );
}

function withWatchedState(item: JellyfinItem, watched: boolean): JellyfinItem {
  return {
    ...item,
    UserData: {
      ...(item.UserData ?? {}),
      PlaybackPositionTicks: watched
        ? (item.RunTimeTicks ?? item.UserData?.PlaybackPositionTicks ?? 0)
        : 0,
      PlayedPercentage: watched ? 100 : 0,
      Played: watched,
      LastPlayedDate: watched ? new Date().toISOString() : null,
    },
  };
}

async function loadLibraryItems(
  id: string,
  mode: "library" | "series" | "season",
  library?: JellyfinItem,
  seriesId?: string,
): Promise<JellyfinItem[]> {
  if (mode === "library") {
    if (
      library?.CollectionType === "tvshows" ||
      library?.CollectionType === "movies"
    ) {
      return getTopLevelItemsForLibrary(id, library.CollectionType);
    }

    const items = await getItemsForLibrary(id);
    return library?.Type === "BoxSet"
      ? sortCollectionItemsForWatching(items)
      : items;
  }

  if (mode === "series") {
    const seasons = await getSeriesSeasons(id);

    if (seasons.length === 0) {
      return getItemsForLibrary(id);
    }

    return Promise.all(
      seasons.map(async (season) => {
        const hasEpisodeCount =
          (season.ChildCount ?? 0) > 0 || (season.RecursiveItemCount ?? 0) > 0;

        if (hasEpisodeCount) {
          return season;
        }

        const episodes = await getSeasonEpisodes(id, season.Id).catch(() => []);

        return {
          ...season,
          ChildCount: episodes.length,
          RecursiveItemCount: episodes.length,
        };
      }),
    );
  }

  const resolvedSeriesId = seriesId ?? library?.SeriesId ?? library?.ParentId;

  if (resolvedSeriesId) {
    const episodes = await getSeasonEpisodes(resolvedSeriesId, id);

    if (episodes.length > 0) {
      return episodes;
    }
  }

  return getItemsForLibrary(id);
}

function MobileLibraryLoading() {
  return (
    <div className="pb-6">
      <div className="flex items-center justify-between">
        <div className="shimmer h-10 w-20 rounded-full" />
        <div className="shimmer h-4 w-24 rounded-full" />
      </div>
      <div className="shimmer mx-auto mt-5 h-10 w-40 rounded-xl" />
      <div className="shimmer mt-6 h-12 rounded-xl" />
      <div className="mt-5 grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="shimmer h-64 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export function MobileLibraryPage({
  mode = "library",
  libraryId: libraryIdOverride,
  canonicalPath: canonicalPathOverride,
  libraryRouteKind,
}: LibraryPageProps) {
  const forceSkeletons = useDevSkeletonMode();
  const { libraryId, seriesId, seasonId } = useParams<{
    libraryId?: string;
    seriesId?: string;
    seasonId?: string;
  }>();
  const activeId = libraryIdOverride ?? libraryId ?? seriesId ?? seasonId;
  const canonicalPath =
    canonicalPathOverride ??
    (libraryRouteKind === "movie" && activeId
      ? `/movies/${activeId}`
      : libraryRouteKind === "collection" && activeId
        ? `/collections/${activeId}`
        : libraryRouteKind === "show" && mode === "series" && activeId
          ? `/shows/${activeId}`
          : libraryRouteKind === "show" &&
              mode === "season" &&
              seriesId &&
              seasonId
            ? `/shows/${seriesId}/season/${seasonId}`
            : libraryRouteKind === "show" && mode === "season" && seasonId
              ? `/shows/season/${seasonId}`
              : mode === "series" && seriesId
                ? `/series/${seriesId}`
                : mode === "season" && seriesId && seasonId
                  ? `/series/${seriesId}/season/${seasonId}`
                  : mode === "season" && seasonId
                    ? `/season/${seasonId}`
                    : activeId
                      ? `/library/${activeId}`
                      : "/home");
  const { t } = useLanguage();
  const labels = useMemo(
    () => ({
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    [t],
  );
  const [data, setData] = useState<LibraryData | null>(null);
  const [loadingItemType, setLoadingItemType] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "year" | "latest">("name");
  const [rotatingLogoIndex, setRotatingLogoIndex] = useState(0);
  const [hasFinishedLogoIntroSweep, setHasFinishedLogoIntroSweep] =
    useState(false);
  const [readyDetailsId, setReadyDetailsId] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadLibrary() {
      if (!activeId) {
        setError(t("library.missingId"));
        return;
      }

      setError(null);
      setData(null);
      setLoadingItemType(undefined);

      try {
        const library = await getItem(activeId).catch(() => undefined);
        if (isMounted) setLoadingItemType(library?.Type);
        const items = await loadLibraryItems(activeId, mode, library, seriesId);
        const collectionPosterChildrenById =
          await loadCollectionPosterChildrenMap(items, getBoxSetItems);
        const firstEpisode = items.find((item) => item.Type === "Episode");
        const selectableSeriesId = firstEpisode
          ? (library?.SeriesId ?? firstEpisode.SeriesId ?? library?.ParentId)
          : undefined;
        const selectableSeasons = selectableSeriesId
          ? await getSeriesSeasons(selectableSeriesId).catch(() => [])
          : [];
        const fallbackLibrary =
          library ??
          (mode === "series"
            ? { Id: activeId, Name: items[0]?.SeriesName ?? "", Type: "Series" }
            : mode === "season"
              ? {
                  Id: activeId,
                  Name: items[0]?.SeasonName ?? "",
                  Type: "Season",
                  SeriesId: seriesId,
                }
              : undefined);
        const fallbackTitleKey: LibraryFallbackTitleKey =
          mode === "series"
            ? "common.series"
            : mode === "season"
              ? "format.season"
              : "library.library";

        if (isMounted) {
          setData({
            library: fallbackLibrary,
            fallbackTitleKey,
            items,
            selectableSeasons,
            collectionPosterChildrenById,
          });
        }
      } catch (libraryError) {
        if (isMounted) {
          const message =
            libraryError instanceof Error
              ? libraryError.message
              : t("library.couldNotLoadView");
          setError(`${mode} id: ${activeId}\n${message}`);
        }
      }
    }

    void loadLibrary();

    return () => {
      isMounted = false;
    };
  }, [activeId, mode, seriesId, t]);

  const filteredItems = useMemo(() => {
    if (!data) {
      return [];
    }

    const query = searchTerm.trim().toLowerCase();
    const items = query
      ? data.items.filter((item) => item.Name.toLowerCase().includes(query))
      : data.items;

    if (data.library?.Type === "BoxSet") {
      return sortCollectionItemsForWatching(items);
    }

    return [...items].sort((left, right) => sortItems(left, right, sortBy));
  }, [data, searchTerm, sortBy]);

  const libraryRotatingLogoUrls = useMemo(() => {
    if (!data || mode !== "library") {
      return [];
    }

    const logoUrls = data.items
      .map((libraryItem) => {
        if (libraryItem.ImageTags?.Logo) {
          return getLogoImageUrl(
            libraryItem.Id,
            libraryItem.ImageTags.Logo,
            900,
          );
        }

        if (libraryItem.ParentLogoItemId && libraryItem.ParentLogoImageTag) {
          return getLogoImageUrl(
            libraryItem.ParentLogoItemId,
            libraryItem.ParentLogoImageTag,
            900,
          );
        }

        return null;
      })
      .filter((url): url is string => Boolean(url));

    return Array.from(new Set(logoUrls));
  }, [data, mode]);

  useEffect(() => {
    setRotatingLogoIndex(0);
    setHasFinishedLogoIntroSweep(false);

    if (mode !== "library" || libraryRotatingLogoUrls.length <= 1) {
      return undefined;
    }

    let currentIndex = 0;
    let hasCompletedInitialSweep = false;
    let timeoutId: number | undefined;
    let introCompleteFrameId: number | undefined;

    const advanceLogo = () => {
      currentIndex = (currentIndex + 1) % libraryRotatingLogoUrls.length;

      setRotatingLogoIndex(currentIndex);

      if (currentIndex === 0) {
        hasCompletedInitialSweep = true;

        introCompleteFrameId = window.requestAnimationFrame(() => {
          setHasFinishedLogoIntroSweep(true);
        });
      }

      timeoutId = window.setTimeout(
        advanceLogo,
        hasCompletedInitialSweep ? 5000 : 100,
      );
    };

    timeoutId = window.setTimeout(advanceLogo, 100);

    return () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }

      if (introCompleteFrameId !== undefined) {
        window.cancelAnimationFrame(introCompleteFrameId);
      }
    };
  }, [libraryRotatingLogoUrls, mode]);

  const handleWatchedStatusReset = (
    resetItems: JellyfinItem[],
    options?: { action: "mark" | "remove"; scope: "show" },
  ) => {
    const resetItemsById = new Map(
      resetItems.map((resetItem) => [resetItem.Id, resetItem]),
    );
    const forceWatched = options ? options.action === "mark" : undefined;

    setData((currentData) =>
      currentData
        ? {
            ...currentData,
            library:
              forceWatched !== undefined && options?.scope === "show"
                ? currentData.library
                  ? withWatchedState(currentData.library, forceWatched)
                  : currentData.library
                : currentData.library,
            items: currentData.items.map(
              (item) =>
                resetItemsById.get(item.Id) ??
                (forceWatched !== undefined && options?.scope === "show"
                  ? withWatchedState(item, forceWatched)
                  : item),
            ),
          }
        : currentData,
    );
  };

  useEffect(() => {
    if (!data) {
      setPageTitle("Seyirlik", {
        canonicalPath,
        robots: "noindex, nofollow",
      });
      return;
    }

    const fallbackTitle = t(data.fallbackTitleKey ?? "library.library");
    const title = data.library?.Name
      ? getDisplayTitle(data.library, labels)
      : fallbackTitle;

    setPageTitle(`${title} · Seyirlik`, {
      canonicalPath,
      robots: "noindex, nofollow",
    });
  }, [canonicalPath, data, labels, t]);

  useEffect(() => {
    const library = data?.library;

    if (!library) {
      return;
    }

    const shouldPreloadPlayback =
      library.Type === "Movie" ||
      library.Type === "Series" ||
      mode === "series";

    if (!shouldPreloadPlayback) {
      return;
    }

    let isMounted = true;

    void preloadMediaPlayback(library, {
      preloadPlayer: () => preloadPlayerPage(true),
    }).catch((preloadError) => {
      if (!isMounted) {
        return;
      }

      console.debug(
        "[Seyirlik Playback] Details playback preload skipped",
        preloadError,
      );
    });

    return () => {
      isMounted = false;
    };
  }, [data?.library?.Id, data?.library?.Type, mode]);

  const isAliasLibrary = [
    "/movies",
    "/shows",
    "/books",
    "/collections",
  ].includes(canonicalPathOverride ?? "");
  const loadingSkeleton = isAliasLibrary ? (
    <MobileLibraryLoading />
  ) : libraryRouteKind === "show" ||
    mode === "series" ||
    mode === "season" ||
    loadingItemType === "Series" ||
    loadingItemType === "Season" ? (
    <ShowLibrarySkeleton mobile />
  ) : libraryRouteKind === "movie" || loadingItemType === "Movie" ? (
    <MovieLibrarySkeleton mobile />
  ) : (
    <MobileLibraryLoading />
  );

  if (forceSkeletons) return loadingSkeleton;

  if (error) {
    return <ErrorMessage title={t("library.unavailable")} message={error} />;
  }

  if (!data) {
    return loadingSkeleton;
  }

  const shouldShowSeriesDetails =
    data.library?.Type === "Series" ||
    data.library?.Type === "Season" ||
    data.library?.Type === "Movie" ||
    mode === "series" ||
    mode === "season";

  if (shouldShowSeriesDetails && data.library) {
    const isInitialDetailsReady = readyDetailsId === activeId;
    const initialDetailsSkeleton =
      data.library.Type === "Movie" || libraryRouteKind === "movie" ? (
        <MovieLibrarySkeleton mobile />
      ) : (
        <ShowLibrarySkeleton mobile />
      );

    return (
      <>
        {!isInitialDetailsReady && initialDetailsSkeleton}
        <div
          aria-hidden={isInitialDetailsReady ? undefined : true}
          className={
            isInitialDetailsReady
              ? "contents"
              : "pointer-events-none fixed inset-0 invisible overflow-hidden"
          }
        >
          <SeriesLibraryDetails
            initialItem={data.library}
            variant="mobile"
            canonicalPath={canonicalPath}
            onInitialReady={() => setReadyDetailsId(activeId ?? null)}
          />
        </div>
      </>
    );
  }

  const fallbackTitle = t(data.fallbackTitleKey ?? "library.library");
  const title = data.library?.Name
    ? getDisplayTitle(data.library, labels)
    : fallbackTitle;
  const itemType = data.items.find((item) => item.Type)?.Type;
  const firstEpisodeItem = data.items.find((item) => item.Type === "Episode");
  const firstItemWithLogo = data.items.find(
    (libraryItem) =>
      Boolean(libraryItem.ImageTags?.Logo) ||
      Boolean(libraryItem.ParentLogoItemId && libraryItem.ParentLogoImageTag),
  );

  const fallbackLogoUrl = data.library?.ImageTags?.Logo
    ? getLogoImageUrl(data.library.Id, data.library.ImageTags.Logo, 900)
    : data.library?.ParentLogoItemId && data.library.ParentLogoImageTag
      ? getLogoImageUrl(
          data.library.ParentLogoItemId,
          data.library.ParentLogoImageTag,
          900,
        )
      : firstItemWithLogo?.ImageTags?.Logo
        ? getLogoImageUrl(
            firstItemWithLogo.Id,
            firstItemWithLogo.ImageTags.Logo,
            900,
          )
        : firstItemWithLogo?.ParentLogoItemId &&
            firstItemWithLogo.ParentLogoImageTag
          ? getLogoImageUrl(
              firstItemWithLogo.ParentLogoItemId,
              firstItemWithLogo.ParentLogoImageTag,
              900,
            )
          : "";

  const activeLibraryLogoUrl =
    mode === "library" && libraryRotatingLogoUrls.length > 0
      ? libraryRotatingLogoUrls[
          rotatingLogoIndex % libraryRotatingLogoUrls.length
        ]
      : fallbackLogoUrl;
  const backdropUrl = getLibraryBackdropUrl(data.library, data.items);
  const countText =
    itemType === "Season"
      ? countLabel(
          data.items.length,
          "media.seasonSingular",
          "media.seasonPlural",
          t,
        )
      : itemType === "Episode"
        ? countLabel(
            data.items.length,
            "media.episodeSingular",
            "media.episodePlural",
            t,
          )
        : `${data.items.length} ${t("library.itemsAvailable")}`;
  const usesLandscapeCards = itemType === "Episode";
  const currentSeasonId =
    data.library?.Type === "Season"
      ? data.library.Id
      : (firstEpisodeItem?.SeasonId ?? activeId);
  const seasonResetSeriesId =
    mode === "season"
      ? (seriesId ?? data.library?.SeriesId ?? firstEpisodeItem?.SeriesId)
      : undefined;
  const showResetSeriesId = mode === "series" ? activeId : undefined;
  const hasWatchedSeasonItems =
    mode === "season" && data.items.some(isItemCompleted);
  const hasWatchedShowItems =
    mode === "series" &&
    (Boolean(data.library && isItemCompleted(data.library)) ||
      data.items.some(isItemCompleted));
  const hasUnwatchedSeasonItems =
    mode === "season" &&
    data.items.some(
      (libraryItem) =>
        isWatchableScopeItem(libraryItem) && !isItemCompleted(libraryItem),
    );
  const hasUnwatchedShowItems =
    mode === "series" && !isWholeWatchedScope(data.library, data.items);
  const isLibraryScopeWatched =
    (mode === "series" || mode === "season") &&
    isWholeWatchedScope(data.library, data.items);
  return (
    <div className="pb-[calc(5.75rem+env(safe-area-inset-bottom))]">
      <section className="full-bleed relative -mt-1 min-h-[7rem] overflow-hidden border-white/10 bg-zinc-950 px-4 pb-12 pt-3">
        <div className="absolute inset-0 bg-gradient-to-b from-black/72 via-black/38 to-[#050506]" />
        <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[#050506] to-transparent" />

        <div className="relative z-20 flex items-center justify-between gap-3">
          <BackButton buttonClassName="min-h-9 px-3 text-xs" />

          <p className="min-w-0 truncate text-right text-xs font-bold text-white/62">
            {countText}
          </p>
        </div>
      </section>

      <div className="relative z-30 -mt-11 mb-5 flex min-h-[5.5rem] items-center justify-center px-4">
        {activeLibraryLogoUrl ? (
          <motion.img
            key={activeLibraryLogoUrl}
            src={activeLibraryLogoUrl}
            alt={title}
            draggable={false}
            className="cinematic-logo-shadow h-auto max-h-16 max-w-[min(16rem,74vw)] transform-gpu object-contain will-change-transform"
            initial={
              hasFinishedLogoIntroSweep
                ? {
                    opacity: 0,
                    y: 6,
                    scale: 1.2,
                    filter: "blur(0px)",
                  }
                : false
            }
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
              filter: "blur(0px)",
            }}
            transition={{
              duration: hasFinishedLogoIntroSweep ? 0.52 : 0,
              ease: [0.16, 1, 0.3, 1],
            }}
          />
        ) : (
          <motion.h1
            className="mx-auto max-w-[84vw] text-center text-3xl font-black tracking-tight text-white drop-shadow-[0_16px_38px_rgba(0,0,0,0.9)]"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.5,
              ease: [0.16, 1, 0.3, 1],
            }}
          >
            {title}
          </motion.h1>
        )}
      </div>

      {isLibraryScopeWatched ? (
        <div className="mb-5 flex justify-center">
          <WatchedIndicator
            isWatched
            className="px-4 py-1.5 text-xs tracking-[0.14em]"
            iconSize={15}
          />
        </div>
      ) : null}

      <div className="mb-5 flex gap-2">
        <label className={`relative min-w-0 flex-1 pl-9 ${glassInputControl}`}>
          <Search
            size={17}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40"
          />
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t("common.search")}
            aria-label={t("library.searchLabel")}
            className="h-11 w-full bg-transparent text-sm text-white outline-none placeholder:text-white/30"
          />
        </label>
        <label
          className={`${glassControlBase} h-12 w-[7.4rem] shrink-0 gap-1.5 px-3 text-xs font-semibold`}
        >
          <SlidersHorizontal size={15} />
          <select
            value={sortBy}
            onChange={(event) =>
              setSortBy(event.target.value as "name" | "year" | "latest")
            }
            aria-label={t("library.sortBy")}
            className="min-w-0 flex-1 bg-transparent text-white outline-none"
          >
            <option value="name">{t("library.name")}</option>
            <option value="latest">{t("library.latest")}</option>
            <option value="year">{t("library.year")}</option>
          </select>
        </label>
        {seasonResetSeriesId && currentSeasonId && hasWatchedSeasonItems ? (
          <WatchedStatusButton
            scope="season"
            action="remove"
            seriesId={seasonResetSeriesId}
            seasonId={currentSeasonId}
            confirm
            onReset={handleWatchedStatusReset}
            className={`${glassControlBase} h-12 w-12 shrink-0`}
            iconSize={16}
          />
        ) : null}
        {seasonResetSeriesId && currentSeasonId && hasUnwatchedSeasonItems ? (
          <WatchedStatusButton
            scope="season"
            action="mark"
            seriesId={seasonResetSeriesId}
            seasonId={currentSeasonId}
            confirm
            onReset={handleWatchedStatusReset}
            className={`${glassControlBase} h-12 w-12 shrink-0`}
            iconSize={16}
          />
        ) : null}
        {showResetSeriesId && hasWatchedShowItems ? (
          <WatchedStatusButton
            scope="show"
            action="remove"
            seriesId={showResetSeriesId}
            confirm
            onReset={(items) =>
              handleWatchedStatusReset(items, {
                action: "remove",
                scope: "show",
              })
            }
            className={`${glassControlBase} h-12 w-12 shrink-0`}
            iconSize={16}
          />
        ) : null}
        {showResetSeriesId && hasUnwatchedShowItems ? (
          <WatchedStatusButton
            scope="show"
            action="mark"
            seriesId={showResetSeriesId}
            confirm
            onReset={(items) =>
              handleWatchedStatusReset(items, {
                action: "mark",
                scope: "show",
              })
            }
            className={`${glassControlBase} h-12 w-12 shrink-0`}
            iconSize={16}
          />
        ) : null}
      </div>

      {filteredItems.length > 0 ? (
        <div
          className={
            usesLandscapeCards
              ? "mx-auto grid max-w-sm grid-cols-1 gap-3"
              : "grid grid-cols-2 gap-x-3 gap-y-4 px-[clamp(0.5rem,4vw,1.75rem)]"
          }
        >
          {filteredItems.map((item) => (
            <MobileMediaCard
              key={item.Id}
              item={item}
              to={getRouteForItem(item)}
              layout="grid"
              variant={item.Type === "Episode" ? "landscape" : "poster"}
              collectionItems={data.collectionPosterChildrenById[item.Id]}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-white/10 bg-[var(--surface)] p-5 text-sm text-white/62">
          {t("library.noMatches")}
        </p>
      )}
    </div>
  );
}
