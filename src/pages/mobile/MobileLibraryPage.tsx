import { useEffect, useMemo, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { useParams } from "react-router-dom";
import { BackButton } from "../../components/BackButton";
import { ErrorMessage } from "../../components/ErrorMessage";
import { MobileMediaCard } from "../../components/mobile/MobileMediaCard";
import { SeasonPicker } from "../../components/SeasonPicker";
import { WatchedIndicator } from "../../components/WatchedIndicator";
import { WatchedStatusButton } from "../../components/WatchedStatusButton";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { getDisplayTitle } from "../../lib/format";
import {
  getBoxSetItems,
  getItem,
  getItemsForLibrary,
  getLogoImageUrl,
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
import { getRouteForItem } from "../../lib/routes";
import type { JellyfinItem } from "../../lib/types";
import { isItemCompleted } from "../../lib/watchStatus";
import type { LibraryPageProps } from "../libraryPageTypes";

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

export function MobileLibraryPage({ mode = "library" }: LibraryPageProps) {
  const { libraryId, seriesId, seasonId } = useParams<{
    libraryId?: string;
    seriesId?: string;
    seasonId?: string;
  }>();
  const activeId = libraryId ?? seriesId ?? seasonId;
  const canonicalPath =
    mode === "series" && seriesId
      ? `/series/${seriesId}`
      : mode === "season" && seriesId && seasonId
        ? `/series/${seriesId}/season/${seasonId}`
        : mode === "season" && seasonId
          ? `/season/${seasonId}`
          : activeId
            ? `/library/${activeId}`
            : "/home";
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
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "year" | "latest">("name");

  useEffect(() => {
    let isMounted = true;

    async function loadLibrary() {
      if (!activeId) {
        setError(t("library.missingId"));
        return;
      }

      setError(null);
      setData(null);

      try {
        const library = await getItem(activeId).catch(() => undefined);
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

  if (error) {
    return <ErrorMessage title={t("library.unavailable")} message={error} />;
  }

  if (!data) {
    return <MobileLibraryLoading />;
  }

  const fallbackTitle = t(data.fallbackTitleKey ?? "library.library");
  const title = data.library?.Name
    ? getDisplayTitle(data.library, labels)
    : fallbackTitle;
  const itemType = data.items.find((item) => item.Type)?.Type;
  const firstEpisodeItem = data.items.find((item) => item.Type === "Episode");
  const logoUrl =
    data.library && !data.library.CollectionType && data.library.ImageTags?.Logo
      ? getLogoImageUrl(data.library.Id, data.library.ImageTags.Logo, 600)
      : data.library?.ParentLogoItemId && data.library.ParentLogoImageTag
        ? getLogoImageUrl(
            data.library.ParentLogoItemId,
            data.library.ParentLogoImageTag,
            600,
          )
        : firstEpisodeItem?.ParentLogoItemId &&
            firstEpisodeItem.ParentLogoImageTag
          ? getLogoImageUrl(
              firstEpisodeItem.ParentLogoItemId,
              firstEpisodeItem.ParentLogoImageTag,
              600,
            )
          : "";
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
  const seasonHeaderLabel =
    itemType === "Episode"
      ? typeof firstEpisodeItem?.ParentIndexNumber === "number" &&
        firstEpisodeItem.ParentIndexNumber > 0
        ? formatTemplate(t("media.seasonNumber"), {
            number: firstEpisodeItem.ParentIndexNumber,
          })
        : data.library?.Name ||
          firstEpisodeItem?.SeasonName ||
          t("format.season")
      : null;
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
  const seasonPickerOptions = [...data.selectableSeasons]
    .sort((left, right) => sortItems(left, right, "name"))
    .map((season) => ({
      id: season.Id,
      label:
        typeof season.IndexNumber === "number" && season.IndexNumber > 0
          ? formatTemplate(t("media.seasonNumber"), {
              number: season.IndexNumber,
            })
          : season.Name || t("format.season"),
    }));

  return (
    <div className="pb-5">
      <div className="mb-5 flex items-center justify-between gap-3">
        <BackButton className="min-h-9 px-3 text-xs" />
        <p className="text-xs font-bold text-white/55">{countText}</p>
      </div>

      <header className="mb-6 text-center">
        {logoUrl && seasonHeaderLabel ? (
          <div className="flex min-w-0 items-center justify-center gap-2.5">
            <img
              src={logoUrl}
              alt={title}
              className="cinematic-logo-shadow max-h-12 max-w-[min(10rem,42vw)] object-contain"
            />
            <div
              aria-hidden="true"
              className="h-9 w-px shrink-0 bg-gradient-to-b from-transparent via-white/24 to-transparent"
            />
            {seasonPickerOptions.length > 0 ? (
              <SeasonPicker
                activeSeasonId={currentSeasonId}
                currentLabel={seasonHeaderLabel}
                options={seasonPickerOptions}
                selectLabel={t("library.selectSeason")}
                variant="mobile"
              />
            ) : (
              <div className="relative max-w-[44vw] overflow-hidden rounded-xl border border-white/[0.12] bg-gray-700 px-3 py-2 shadow-soft-inset">
                <span className="relative truncate text-sm font-black leading-none text-white">
                  {seasonHeaderLabel}
                </span>
              </div>
            )}
          </div>
        ) : logoUrl ? (
          <img
            src={logoUrl}
            alt={title}
            className="cinematic-logo-shadow mx-auto max-h-14 max-w-[75vw] object-contain"
          />
        ) : (
          <h1 className="text-3xl font-black tracking-tight text-white">
            {title}
          </h1>
        )}
      </header>

      {isLibraryScopeWatched ? (
        <div className="mb-5 flex justify-center">
          <WatchedIndicator
            isWatched
            className="px-4 py-1.5 text-xs tracking-[0.14em]"
            iconSize={15}
          />
        </div>
      ) : null}

      <div className="mb-5 flex gap-2 rounded-2xl border border-white/10 bg-white/[0.05] p-2">
        <label className="relative min-w-0 flex-1">
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
            className="h-11 w-full rounded-xl border border-white/10 bg-black/35 pl-9 pr-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-[var(--accent)]"
          />
        </label>
        <label className="flex h-11 w-[7.4rem] shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-black/35 px-2 text-xs font-semibold text-white/70">
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
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-black/35 text-white/70 transition hover:bg-white/[0.09] hover:text-white"
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
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-200/70 bg-emerald-300 text-black transition hover:bg-emerald-200"
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
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-black/35 text-white/70 transition hover:bg-white/[0.09] hover:text-white"
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
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-200/70 bg-emerald-300 text-black transition hover:bg-emerald-200"
            iconSize={16}
          />
        ) : null}
      </div>

      {filteredItems.length > 0 ? (
        <div
          className={
            usesLandscapeCards
              ? "grid grid-cols-1 gap-3"
              : "grid grid-cols-2 gap-3"
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
              onWatchedStatusReset={handleWatchedStatusReset}
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
