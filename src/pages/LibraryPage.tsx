import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Search, SlidersHorizontal } from "lucide-react";
import { BackButton } from "../components/BackButton";
import { ErrorMessage } from "../components/ErrorMessage";
import { MediaCard } from "../components/MediaCard";
import { MotionReveal } from "../components/MotionReveal";
import { LibrarySkeleton } from "../components/Skeletons";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";
import {
  getItem,
  getItemsForLibrary,
  getLogoImageUrl,
  getSeasonEpisodes,
  getSeriesSeasons,
  getTopLevelItemsForLibrary,
} from "../lib/jellyfinApi";
import { getDisplayTitle } from "../lib/format";
import { getRouteForItem } from "../lib/routes";
import type { JellyfinItem } from "../lib/types";
import { AnimatedText } from "../components/AnimatedText";
import { AnimatedWidth } from "../components/AnimatedWidth";
import { setPageTitle } from "../lib/pageTitle";

type LibraryFallbackTitleKey =
  | "common.series"
  | "format.season"
  | "library.library";

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

interface LibraryData {
  library?: JellyfinItem;
  fallbackTitleKey?: LibraryFallbackTitleKey;
  items: JellyfinItem[];
}

function getSortNumber(item: JellyfinItem): number {
  if (item.Type === "Season") {
    return item.IndexNumber ?? item.ProductionYear ?? 9999;
  }

  if (item.Type === "Episode") {
    return item.IndexNumber ?? 9999;
  }

  return 9999;
}

function compareNames(left: JellyfinItem, right: JellyfinItem): number {
  return (left.SortName ?? left.Name).localeCompare(
    right.SortName ?? right.Name,
    undefined,
    { numeric: true },
  );
}

function compareDates(leftDate?: string, rightDate?: string): number {
  const leftTime = Date.parse(leftDate ?? "9999-12-31");
  const rightTime = Date.parse(rightDate ?? "9999-12-31");
  return leftTime - rightTime;
}

function sortJellyfinItems(
  left: JellyfinItem,
  right: JellyfinItem,
  sortBy: "name" | "year" | "latest",
): number {
  if (left.Type === "Season" && right.Type === "Season") {
    const seasonCompare = getSortNumber(left) - getSortNumber(right);
    return seasonCompare !== 0 ? seasonCompare : compareNames(left, right);
  }

  if (left.Type === "Episode" && right.Type === "Episode") {
    const seasonCompare =
      (left.ParentIndexNumber ?? 0) - (right.ParentIndexNumber ?? 0);

    if (seasonCompare !== 0) {
      return seasonCompare;
    }

    const episodeCompare = getSortNumber(left) - getSortNumber(right);

    if (episodeCompare !== 0) {
      return episodeCompare;
    }

    const dateCompare = compareDates(left.PremiereDate, right.PremiereDate);
    return dateCompare !== 0 ? dateCompare : compareNames(left, right);
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

async function loadLibraryItems(
  id: string,
  mode: "library" | "series" | "season",
  library?: JellyfinItem,
  seriesIdFromRoute?: string,
): Promise<JellyfinItem[]> {
  if (mode === "library") {
    if (
      library?.CollectionType === "tvshows" ||
      library?.CollectionType === "movies"
    ) {
      return getTopLevelItemsForLibrary(id, library.CollectionType);
    }

    return getItemsForLibrary(id);
  }

  if (mode === "series") {
    const seasons = await getSeriesSeasons(id);

    if (seasons.length > 0) {
      const seasonsWithEpisodeCounts = await Promise.all(
        seasons.map(async (season) => {
          const existingCount =
            typeof season.ChildCount === "number" && season.ChildCount > 0
              ? season.ChildCount
              : typeof season.RecursiveItemCount === "number" &&
                  season.RecursiveItemCount > 0
                ? season.RecursiveItemCount
                : null;

          if (existingCount !== null) {
            return season;
          }

          const episodes = await getSeasonEpisodes(id, season.Id).catch(
            () => [],
          );

          return {
            ...season,
            ChildCount: episodes.length,
            RecursiveItemCount: episodes.length,
          };
        }),
      );

      return seasonsWithEpisodeCounts;
    }

    return getItemsForLibrary(id);
  }

  if (mode === "season") {
    const resolvedSeriesId =
      seriesIdFromRoute ?? library?.SeriesId ?? library?.ParentId;

    if (resolvedSeriesId) {
      const episodes = await getSeasonEpisodes(resolvedSeriesId, id);

      if (episodes.length > 0) {
        return episodes;
      }
    }

    return getItemsForLibrary(id);
  }

  return getItemsForLibrary(id);
}

interface LibraryPageProps {
  mode?: "library" | "series" | "season";
}

export function LibraryPage({ mode = "library" }: LibraryPageProps) {
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
  const mediaFormatLabels = useMemo(
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
  const [rotatingLogoIndex, setRotatingLogoIndex] = useState(0);
  const [hasFinishedLogoIntroSweep, setHasFinishedLogoIntroSweep] =
    useState(false);

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
        const libraryResult = await getItem(activeId).catch(() => undefined);
        const items = await loadLibraryItems(
          activeId,
          mode,
          libraryResult,
          seriesId,
        );

        const fallbackLibrary =
          libraryResult ??
          (mode === "series"
            ? {
                Id: activeId,
                Name: items[0]?.SeriesName ?? "",
                Type: "Series",
              }
            : mode === "season"
              ? {
                  Id: activeId,
                  Name: items[0]?.SeasonName ?? "",
                  Type: "Season",
                  SeriesId: seriesId,
                }
              : undefined);
        const fallbackTitleKey: LibraryFallbackTitleKey | undefined =
          mode === "series"
            ? "common.series"
            : mode === "season"
              ? "format.season"
              : "library.library";

        if (isMounted) {
          setData({ library: fallbackLibrary, fallbackTitleKey, items });
        }
      } catch (libraryError) {
        if (isMounted) {
          setError(
            libraryError instanceof Error
              ? `${mode} id: ${activeId}\n${libraryError.message}`
              : `${mode} id: ${activeId}\n${t("library.couldNotLoadView")}`,
          );
        }
      }
    }

    void loadLibrary();

    return () => {
      isMounted = false;
    };
  }, [activeId, mode, seriesId]);

  const filteredItems = useMemo(() => {
    if (!data) {
      return [];
    }

    const normalizedSearch = searchTerm.trim().toLowerCase();
    const items = normalizedSearch
      ? data.items.filter((item) =>
          item.Name.toLowerCase().includes(normalizedSearch),
        )
      : data.items;

    return [...items].sort((left, right) =>
      sortJellyfinItems(left, right, sortBy),
    );
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
            1100,
          );
        }

        if (libraryItem.ParentLogoItemId && libraryItem.ParentLogoImageTag) {
          return getLogoImageUrl(
            libraryItem.ParentLogoItemId,
            libraryItem.ParentLogoImageTag,
            1100,
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
  }, [libraryRotatingLogoUrls.length, mode]);

  useEffect(() => {
    if (data) {
      return;
    }

    setPageTitle("Seyirlik", {
      canonicalPath,
      robots: "noindex, nofollow",
    });
  }, [canonicalPath, data]);

  useEffect(() => {
    if (!data) {
      return;
    }

    const fallbackTitle =
      data.library?.Name ||
      (data.fallbackTitleKey
        ? t(data.fallbackTitleKey as TranslationKey)
        : t("library.library"));
    const title = data.library?.Name
      ? getDisplayTitle(data.library, mediaFormatLabels)
      : fallbackTitle;

    setPageTitle(`${title} · Seyirlik`, {
      canonicalPath,
      robots: "noindex, nofollow",
    });
  }, [canonicalPath, data, mediaFormatLabels, t]);

  if (error) {
    return <ErrorMessage title={t("library.unavailable")} message={error} />;
  }

  if (!data) {
    return <LibrarySkeleton />;
  }

  const libraryTitle =
    data.library?.Name ||
    (data.fallbackTitleKey
      ? t(data.fallbackTitleKey as TranslationKey)
      : t("library.library"));

  const firstItemWithLogo = data.items.find(
    (libraryItem) =>
      Boolean(libraryItem.ImageTags?.Logo) ||
      Boolean(libraryItem.ParentLogoItemId && libraryItem.ParentLogoImageTag),
  );
  const libraryLogoUrl = data.library?.ImageTags?.Logo
    ? getLogoImageUrl(data.library.Id, data.library.ImageTags.Logo, 1100)
    : data.library?.ParentLogoItemId && data.library.ParentLogoImageTag
      ? getLogoImageUrl(
          data.library.ParentLogoItemId,
          data.library.ParentLogoImageTag,
          1100,
        )
      : firstItemWithLogo?.ParentLogoItemId &&
          firstItemWithLogo.ParentLogoImageTag
        ? getLogoImageUrl(
            firstItemWithLogo.ParentLogoItemId,
            firstItemWithLogo.ParentLogoImageTag,
            1100,
          )
        : firstItemWithLogo?.ImageTags?.Logo
          ? getLogoImageUrl(
              firstItemWithLogo.Id,
              firstItemWithLogo.ImageTags.Logo,
              1100,
            )
          : "";
  const activeLibraryLogoUrl =
    mode === "library" && libraryRotatingLogoUrls.length > 0
      ? libraryRotatingLogoUrls[
          rotatingLogoIndex % libraryRotatingLogoUrls.length
        ]
      : libraryLogoUrl;
  const displayLibraryTitle = data.library?.Name
    ? getDisplayTitle(data.library, mediaFormatLabels)
    : libraryTitle;

  const visibleItemType = data.items.find(
    (libraryItem) => libraryItem.Type,
  )?.Type;

  const headerCountLabel =
    visibleItemType === "Season"
      ? `${data.items.length} Sezon`
      : visibleItemType === "Episode"
        ? `${data.items.length} Bölüm`
        : `${data.items.length} ${t("library.itemsAvailable")}`;
  const firstEpisodeItem = data.items.find(
    (libraryItem) => libraryItem.Type === "Episode",
  );

  const seasonHeaderLabel =
    visibleItemType === "Episode"
      ? typeof firstEpisodeItem?.ParentIndexNumber === "number" &&
        firstEpisodeItem.ParentIndexNumber > 0
        ? formatTemplate(t("media.seasonNumber"), {
            number: firstEpisodeItem.ParentIndexNumber,
          })
        : data.library?.Name ||
          firstEpisodeItem?.SeasonName ||
          t("format.season")
      : null;

  return (
    <div>
      <div className="relative mb-3 grid min-h-20 grid-cols-[auto_1fr_auto] items-end gap-4">
        <div className="justify-self-start pb-1">
          <BackButton />
        </div>

        <MotionReveal
          className="flex min-w-0 justify-center px-2"
          direction="up"
          delay={0.02}
        >
          {activeLibraryLogoUrl && seasonHeaderLabel ? (
            <div className="relative flex min-h-[5rem] w-full min-w-0 items-center justify-center sm:min-h-[5.5rem]">
              <motion.img
                src={activeLibraryLogoUrl}
                alt={displayLibraryTitle}
                draggable={false}
                className="cinematic-logo-shadow absolute left-1/2 z-30 h-auto max-h-[4.6rem] max-w-[min(18rem,40vw)] -translate-x-1/2 transform-gpu object-contain will-change-transform sm:max-h-20"
                initial={{
                  opacity: 0,
                  x: "-50%",
                  scale: 0.98,
                }}
                animate={{
                  opacity: 1,
                  x: "calc(-50% - 7.45rem)",
                  scale: 1,
                }}
                transition={{
                  opacity: { duration: 0.55, ease: [0.22, 1, 0.36, 1] },
                  scale: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
                  x: {
                    duration: 1.05,
                    delay: 1.15,
                    ease: [0.16, 1, 0.3, 1],
                  },
                }}
              />

              <motion.div
                aria-hidden="true"
                className="absolute left-1/2 z-10 h-12 w-px shrink-0 origin-center bg-gradient-to-b from-transparent via-white/24 to-transparent will-change-transform sm:h-14"
                initial={{
                  opacity: 0,
                  scaleY: 0.55,
                  x: "1.75rem",
                }}
                animate={{
                  opacity: 1,
                  scaleY: 1,
                  x: "1.85rem",
                }}
                transition={{
                  duration: 0.78,
                  delay: 1.55,
                  ease: [0.16, 1, 0.3, 1],
                }}
              />

              <motion.div
                className="group/season-label absolute left-1/2 z-20 transform-gpu overflow-hidden rounded-2xl border border-white/[0.12] bg-gray-700 px-4 py-2.5 shadow-soft-inset will-change-[transform,opacity,filter] sm:px-5 sm:py-3"
                initial={{
                  opacity: 0,
                  x: "1.55rem",
                  scale: 0.975,
                  filter: "blur(6px)",
                }}
                animate={{
                  opacity: 1,
                  x: "2.55rem",
                  scale: 1,
                  filter: "blur(0px)",
                }}
                transition={{
                  duration: 0.95,
                  delay: 1.25,
                  ease: [0.16, 1, 0.3, 1],
                }}
              >
                <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,var(--accent-soft),transparent_58%)] opacity-70" />

                <div className="relative flex items-center">
                  <span className="text-2xl font-black leading-none tracking-[-0.04em] text-white sm:text-4xl">
                    <AnimatedWidth value={seasonHeaderLabel}>
                      <AnimatedText value={seasonHeaderLabel} />
                    </AnimatedWidth>
                  </span>
                </div>
              </motion.div>
            </div>
          ) : activeLibraryLogoUrl ? (
            <motion.img
              key={activeLibraryLogoUrl}
              src={activeLibraryLogoUrl}
              alt={displayLibraryTitle}
              draggable={false}
              className="cinematic-logo-shadow h-auto max-h-20 max-w-[min(26rem,58vw)] object-contain"
              initial={
                hasFinishedLogoIntroSweep
                  ? { opacity: 0, y: 6, scale: 1.2, filter: "blur(0px)" }
                  : false
              }
              animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
              transition={{
                duration: hasFinishedLogoIntroSweep ? 0.52 : 0,
                ease: [0.16, 1, 0.3, 1],
              }}
            />
          ) : (
            <h1 className="text-center text-4xl font-black leading-none text-white sm:text-5xl">
              <AnimatedWidth value={displayLibraryTitle}>
                <AnimatedText value={displayLibraryTitle} />
              </AnimatedWidth>
            </h1>
          )}
        </MotionReveal>

        <p className="justify-self-end pb-2 text-right text-sm font-bold text-white/[0.62]">
          <AnimatedWidth value={headerCountLabel}>
            <AnimatedText value={headerCountLabel} />
          </AnimatedWidth>
        </p>
      </div>

      <MotionReveal
        className="mb-7 flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.055] p-3 backdrop-blur md:flex-row md:items-center md:justify-between"
        delay={0.04}
      >
        <label className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/[0.42]"
            size={19}
          />
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t("library.searchPlaceholder")}
            aria-label={t("library.searchLabel")}
            className="min-h-12 w-full rounded-xl border border-white/10 bg-black/[0.35] py-3 pl-11 pr-4 text-white outline-none transition placeholder:text-white/35 focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20"
          />
        </label>
        <label className="flex min-h-12 items-center gap-2 rounded-xl border border-white/10 bg-black/[0.35] px-3 text-sm font-semibold text-white/[0.72]">
          <SlidersHorizontal size={18} />
          <select
            value={sortBy}
            onChange={(event) =>
              setSortBy(event.target.value as "name" | "year" | "latest")
            }
            aria-label={t("library.sortBy")}
            className="bg-transparent text-white outline-none"
          >
            <option value="name">{t("library.name")}</option>
            <option value="latest">{t("library.latest")}</option>
            <option value="year">{t("library.year")}</option>
          </select>
        </label>
      </MotionReveal>

      {filteredItems.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6">
          {filteredItems.map((item, index) => (
            <MediaCard
              key={item.Id}
              item={item}
              to={getRouteForItem(item)}
              layout="grid"
              variant={item.Type === "Episode" ? "landscape" : "poster"}
              index={index}
              animateIn
              showPlayFromBeginning
            />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-white/10 bg-[var(--surface)] p-5 text-sm text-white/[0.62]">
          <AnimatedWidth value={t("library.noMatches")}>
            <AnimatedText value={t("library.noMatches")} />
          </AnimatedWidth>
        </p>
      )}
    </div>
  );
}
