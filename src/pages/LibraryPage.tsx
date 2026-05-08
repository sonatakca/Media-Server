import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Search, SlidersHorizontal } from "lucide-react";
import { ErrorMessage } from "../components/ErrorMessage";
import { MediaCard } from "../components/MediaCard";
import { DetailsSkeleton } from "../components/Skeletons";
import { useLanguage } from "../i18n/LanguageContext";
import { getBackdropImageUrl, getItem, getTopLevelItemsForLibrary } from "../lib/jellyfinApi";
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

function sortJellyfinItems(left: JellyfinItem, right: JellyfinItem, sortBy: "name" | "year" | "latest"): number {
  if (left.Type === "Season" && right.Type === "Season") {
    return getSortNumber(left) - getSortNumber(right);
  }

  if (left.Type === "Episode" && right.Type === "Episode") {
    const seasonCompare = (left.ParentIndexNumber ?? 0) - (right.ParentIndexNumber ?? 0);

    if (seasonCompare !== 0) {
      return seasonCompare;
    }

    return getSortNumber(left) - getSortNumber(right);
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

  return left.Name.localeCompare(right.Name);
}

export function LibraryPage() {
  const navigate = useNavigate();
  const { libraryId } = useParams<{ libraryId: string }>();
  const { t } = useLanguage();
  const [data, setData] = useState<LibraryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "year" | "latest">("name");

  useEffect(() => {
    let isMounted = true;

    async function loadLibrary() {
      if (!libraryId) {
        setError("Missing library id.");
        return;
      }

      setError(null);
      setData(null);

      try {
        const libraryResult = await getItem(libraryId).catch(() => undefined);
        const items = await getTopLevelItemsForLibrary(libraryId, libraryResult?.CollectionType);

        if (isMounted) {
          setData({ library: libraryResult, items });
        }
      } catch (libraryError) {
        if (isMounted) {
          setError(libraryError instanceof Error ? libraryError.message : "Could not load this library.");
        }
      }
    }

    void loadLibrary();

    return () => {
      isMounted = false;
    };
  }, [libraryId]);

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
          <img src={libraryBackdrop} alt="" className="absolute inset-0 h-full w-full object-cover opacity-35" />
        ) : (
          <div className="absolute inset-0 bg-[linear-gradient(145deg,#18181b,#050506)]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[var(--background)] via-black/[0.62] to-black/30" />
        <div className="relative mx-auto max-w-[1600px]">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="mb-14 inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.08] px-4 text-sm font-semibold text-zinc-200 backdrop-blur transition hover:bg-white/[0.14] hover:text-white"
          >
            <ArrowLeft size={17} />
            {t("common.back")}
          </button>

          <div className="max-w-4xl">
            <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">{t("library.library")}</p>
            <h1 className="mt-2 text-5xl font-black leading-none text-white sm:text-6xl">
              {data.library?.Name ?? t("library.library")}
            </h1>
            <p className="mt-4 text-base font-medium text-white/[0.62]">
              {data.items.length} {t("library.itemsAvailable")}
            </p>
          </div>
        </div>
      </section>

      <div className="mb-7 flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.055] p-3 backdrop-blur md:flex-row md:items-center md:justify-between">
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
      </div>

      {filteredItems.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6">
          {filteredItems.map((item) => (
            <MediaCard key={item.Id} item={item} to={`/library/${item.Id}`} layout="grid" />
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
