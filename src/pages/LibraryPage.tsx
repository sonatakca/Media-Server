import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Navigate, useParams } from "react-router-dom";
import { Search, SlidersHorizontal } from "lucide-react";
import { BackButton } from "../components/BackButton";
import { ErrorMessage } from "../components/ErrorMessage";
import { MediaCard } from "../components/MediaCard";
import { MotionReveal } from "../components/MotionReveal";
import { DetailsSkeleton } from "../components/Skeletons";
import { useLanguage } from "../i18n/LanguageContext";
import { getBackdropImageUrl, getItem, getItemsForLibrary, getSeasonEpisodes, getSeriesSeasons, getTopLevelItemsForLibrary } from "../lib/jellyfinApi";
import { getDisplayTitle } from "../lib/format";
import { getRouteForItem } from "../lib/routes";
import type { JellyfinItem } from "../lib/types";

interface LibraryData {
  library?: JellyfinItem;
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
  return (left.SortName ?? left.Name).localeCompare(right.SortName ?? right.Name, undefined, { numeric: true });
}

function compareDates(leftDate?: string, rightDate?: string): number {
  const leftTime = Date.parse(leftDate ?? "9999-12-31");
  const rightTime = Date.parse(rightDate ?? "9999-12-31");
  return leftTime - rightTime;
}

function sortJellyfinItems(left: JellyfinItem, right: JellyfinItem, sortBy: "name" | "year" | "latest"): number {
  if (left.Type === "Season" && right.Type === "Season") {
    const seasonCompare = getSortNumber(left) - getSortNumber(right);
    return seasonCompare !== 0 ? seasonCompare : compareNames(left, right);
  }

  if (left.Type === "Episode" && right.Type === "Episode") {
    const seasonCompare = (left.ParentIndexNumber ?? 0) - (right.ParentIndexNumber ?? 0);

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
    if (library?.CollectionType === "tvshows" || library?.CollectionType === "movies") {
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
              : typeof season.RecursiveItemCount === "number" && season.RecursiveItemCount > 0
                ? season.RecursiveItemCount
                : null;

          if (existingCount !== null) {
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

      return seasonsWithEpisodeCounts;
    }

    return getItemsForLibrary(id);
  }

  if (mode === "season") {
    const resolvedSeriesId = seriesIdFromRoute ?? library?.SeriesId ?? library?.ParentId;

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
  const { t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const [data, setData] = useState<LibraryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "year" | "latest">("name");

  useEffect(() => {
    let isMounted = true;

    async function loadLibrary() {
      if (!activeId) {
        setError("Missing library id.");
        return;
      }

      setError(null);
      setData(null);

      try {
        const libraryResult = await getItem(activeId).catch(() => undefined);
        const items = await loadLibraryItems(activeId, mode, libraryResult, seriesId);

        const fallbackLibrary =
          libraryResult ??
          (mode === "series"
            ? {
                Id: activeId,
                Name: items[0]?.SeriesName ?? "Series",
                Type: "Series",
              }
            : mode === "season"
              ? {
                  Id: activeId,
                  Name: items[0]?.SeasonName ?? "Season",
                  Type: "Season",
                  SeriesId: seriesId,
                }
              : undefined);

        if (isMounted) {
          setData({ library: fallbackLibrary, items });
        }
      } catch (libraryError) {
        if (isMounted) {
          setError(
            libraryError instanceof Error
              ? `${mode} id: ${activeId}\n${libraryError.message}`
              : `${mode} id: ${activeId}\nCould not load this view.`,
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
      ? data.items.filter((item) => item.Name.toLowerCase().includes(normalizedSearch))
      : data.items;

    return [...items].sort((left, right) => sortJellyfinItems(left, right, sortBy));
  }, [data, searchTerm, sortBy]);

  if (error) {
    return <ErrorMessage title={t("library.unavailable")} message={error} />;
  }

  if (!data) {
    return <DetailsSkeleton />;
  }

  const libraryBackdrop =
    data.library?.BackdropImageTags?.[0] && data.library
      ? getBackdropImageUrl(data.library.Id, data.library.BackdropImageTags[0], 1600)
      : "";

  return (
    <div>
      <section className="relative -mx-4 -mt-6 mb-8 overflow-hidden rounded-b-3xl px-4 pb-8 pt-8 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        {libraryBackdrop ? (
          <motion.img
            src={libraryBackdrop}
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-35"
            initial={shouldReduceMotion ? false : { opacity: 0, scale: 1.035 }}
            animate={shouldReduceMotion ? undefined : { opacity: 0.35, scale: 1 }}
            transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
          />
        ) : (
          <div className="absolute inset-0 bg-[linear-gradient(145deg,#18181b,#050506)]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[var(--background)] via-black/[0.62] to-black/30" />
        <div className="relative mx-auto max-w-[1600px]">
          <BackButton className="mb-14" />

          <MotionReveal className="max-w-4xl" direction="up">
            <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">{t("library.library")}</p>
            <h1 className="mt-2 text-5xl font-black leading-none text-white sm:text-6xl">
              {data.library ? getDisplayTitle(data.library) : t("library.library")}
            </h1>
            <p className="mt-4 text-base font-medium text-white/[0.62]">
              {data.items.length} {t("library.itemsAvailable")}
            </p>
          </MotionReveal>
        </div>
      </section>

      <MotionReveal className="mb-7 flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.055] p-3 backdrop-blur md:flex-row md:items-center md:justify-between" delay={0.04}>
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/[0.42]" size={19} />
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t("library.searchPlaceholder")}
            className="min-h-12 w-full rounded-xl border border-white/10 bg-black/[0.35] py-3 pl-11 pr-4 text-white outline-none transition placeholder:text-white/35 focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20"
          />
        </label>
        <label className="flex min-h-12 items-center gap-2 rounded-xl border border-white/10 bg-black/[0.35] px-3 text-sm font-semibold text-white/[0.72]">
          <SlidersHorizontal size={18} />
          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as "name" | "year" | "latest")}
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
            />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-white/10 bg-[var(--surface)] p-5 text-sm text-white/[0.62]">
          {t("library.noMatches")}
        </p>
      )}
    </div>
  );
}
