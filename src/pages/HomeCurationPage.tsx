import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUp,
  ArrowUpToLine,
  Check,
  EyeOff,
  ListOrdered,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "../components/Button";
import { ErrorMessage } from "../components/ErrorMessage";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { Tooltip } from "../components/ui/Tooltip";
import { useLanguage } from "../i18n/LanguageContext";
import {
  buildHomeCarouselPool,
  clearHomeCurationPreferences,
  DEFAULT_HOME_CURATION_PREFERENCES,
  loadHomeCurationPreferences,
  orderHomeCarouselItemsForEditor,
  orderLatestMediaItemsForEditor,
  saveHomeCurationPreferences,
  type HomeCurationPreferences,
} from "../lib/homeCuration";
import { getDisplayTitle, getItemSubtitle } from "../lib/format";
import {
  getAllMovieAndSeriesItems,
  getBackdropImageUrl,
  getLatestMediaItems,
  getPrimaryImageUrl,
} from "../lib/jellyfinApi";
import { setPageTitle } from "../lib/pageTitle";
import type { JellyfinItem } from "../lib/types";

type CurationSection = "carousel" | "latest";

interface HomeCurationData {
  carouselItems: JellyfinItem[];
  latestItems: JellyfinItem[];
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

function getItemArtworkUrl(item: JellyfinItem): string {
  if (item.ImageTags?.Primary) {
    return getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 360);
  }

  if (item.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(item.Id, item.BackdropImageTags[0], 520);
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    return getBackdropImageUrl(
      item.ParentBackdropItemId,
      item.ParentBackdropImageTags[0],
      520,
    );
  }

  return "";
}

function getItemTypeLabel(
  item: JellyfinItem,
  t: ReturnType<typeof useLanguage>["t"],
): string {
  if (item.Type === "Movie") {
    return t("common.movie");
  }

  if (item.Type === "Series") {
    return t("common.series");
  }

  return item.Type ?? t("common.unknown");
}

function itemMatchesQuery(
  item: JellyfinItem,
  query: string,
  t: ReturnType<typeof useLanguage>["t"],
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  const searchableText = [
    getDisplayTitle(item),
    item.Name,
    item.SortName,
    item.SeriesName,
    item.ProductionYear?.toString(),
    getItemTypeLabel(item, t),
    item.Id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();

  return searchableText.includes(normalizedQuery);
}

function toggleId(ids: string[], itemId: string): string[] {
  return ids.includes(itemId)
    ? ids.filter((candidateId) => candidateId !== itemId)
    : [...ids, itemId];
}

function moveItemId(
  ids: string[],
  itemId: string,
  direction: -1 | 1,
): string[] {
  const index = ids.indexOf(itemId);
  const nextIndex = index + direction;

  if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) {
    return ids;
  }

  const nextIds = [...ids];
  const [itemToMove] = nextIds.splice(index, 1);
  nextIds.splice(nextIndex, 0, itemToMove);

  return nextIds;
}

function moveItemIdToIndex(
  ids: string[],
  itemId: string,
  targetIndex: number,
): string[] {
  const index = ids.indexOf(itemId);
  const boundedTargetIndex = Math.min(
    Math.max(targetIndex, 0),
    Math.max(ids.length - 1, 0),
  );

  if (index < 0 || index === boundedTargetIndex) {
    return ids;
  }

  const nextIds = [...ids];
  const [itemToMove] = nextIds.splice(index, 1);
  nextIds.splice(boundedTargetIndex, 0, itemToMove);

  return nextIds;
}

interface CurationItemRowProps {
  item: JellyfinItem;
  enabled: boolean;
  enabledLabel: string;
  disabledLabel: string;
  toggleLabel: string;
  onToggle: () => void;
  canMoveToTop?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  canMoveToBottom?: boolean;
  onMoveToTop?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onMoveToBottom?: () => void;
}

function CurationItemRow({
  item,
  enabled,
  enabledLabel,
  disabledLabel,
  toggleLabel,
  onToggle,
  canMoveToTop = false,
  canMoveUp = false,
  canMoveDown = false,
  canMoveToBottom = false,
  onMoveToTop,
  onMoveUp,
  onMoveDown,
  onMoveToBottom,
}: CurationItemRowProps) {
  const { t } = useLanguage();
  const artworkUrl = getItemArtworkUrl(item);
  const title = getDisplayTitle(item, {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  });
  const subtitle = [
    getItemTypeLabel(item, t),
    item.ProductionYear,
    getItemSubtitle(item, {
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
  ].filter(Boolean);
  const moveTopLabel = formatTemplate(t("homeCuration.moveTopItem"), {
    title,
  });
  const moveUpLabel = formatTemplate(t("homeCuration.moveUpItem"), {
    title,
  });
  const moveDownLabel = formatTemplate(t("homeCuration.moveDownItem"), {
    title,
  });
  const moveBottomLabel = formatTemplate(t("homeCuration.moveBottomItem"), {
    title,
  });

  return (
    <article
      className={`grid gap-3 rounded-2xl border p-3 transition sm:grid-cols-[auto_1fr_auto] sm:items-center ${
        enabled
          ? "border-white/10 bg-black/32"
          : "border-white/[0.07] bg-black/18 opacity-58"
      }`}
    >
      <div className="h-20 w-14 overflow-hidden rounded-xl bg-white/[0.08] sm:h-24 sm:w-16">
        {artworkUrl ? (
          <img
            src={artworkUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs font-black text-white/28">
            {item.Type?.slice(0, 2).toUpperCase() ?? "?"}
          </div>
        )}
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate text-base font-black text-white">
            {title}
          </h2>
          <span
            className={`rounded-full px-2 py-0.5 text-[0.68rem] font-black uppercase tracking-[0.12em] ${
              enabled
                ? "bg-emerald-300/12 text-emerald-100/82"
                : "bg-white/[0.07] text-white/38"
            }`}
          >
            {enabled ? enabledLabel : disabledLabel}
          </span>
        </div>

        <p className="mt-1 truncate text-sm font-semibold text-white/48">
          {subtitle.join(" · ")}
        </p>
      </div>

      <div className="flex flex-wrap gap-2 sm:justify-end">
        {onMoveToTop ? (
          <Tooltip content={moveTopLabel}>
            <button
              type="button"
              onClick={onMoveToTop}
              disabled={!canMoveToTop}
              aria-label={moveTopLabel}
              className="inline-flex min-h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/72 transition hover:bg-white/[0.12] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUpToLine size={16} />
            </button>
          </Tooltip>
        ) : null}

        {onMoveUp ? (
          <Tooltip content={moveUpLabel}>
            <button
              type="button"
              onClick={onMoveUp}
              disabled={!canMoveUp}
              aria-label={moveUpLabel}
              className="inline-flex min-h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/72 transition hover:bg-white/[0.12] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUp size={16} />
            </button>
          </Tooltip>
        ) : null}

        {onMoveDown ? (
          <Tooltip content={moveDownLabel}>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={!canMoveDown}
              aria-label={moveDownLabel}
              className="inline-flex min-h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/72 transition hover:bg-white/[0.12] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowDown size={16} />
            </button>
          </Tooltip>
        ) : null}

        {onMoveToBottom ? (
          <Tooltip content={moveBottomLabel}>
            <button
              type="button"
              onClick={onMoveToBottom}
              disabled={!canMoveToBottom}
              aria-label={moveBottomLabel}
              className="inline-flex min-h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/72 transition hover:bg-white/[0.12] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowDownToLine size={16} />
            </button>
          </Tooltip>
        ) : null}

        <button
          type="button"
          onClick={onToggle}
          className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-full border px-3 text-sm font-black transition ${
            enabled
              ? "border-emerald-300/18 bg-emerald-300/10 text-emerald-50 hover:bg-emerald-300/16"
              : "border-white/10 bg-white/[0.06] text-white/62 hover:bg-white/[0.12] hover:text-white"
          }`}
        >
          {enabled ? <Check size={15} /> : <EyeOff size={15} />}
          {toggleLabel}
        </button>
      </div>
    </article>
  );
}

export function HomeCurationPage() {
  const { t } = useLanguage();
  const [data, setData] = useState<HomeCurationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] =
    useState<CurationSection>("carousel");
  const [preferences, setPreferences] = useState<HomeCurationPreferences>(() =>
    loadHomeCurationPreferences(),
  );
  const [savedAt, setSavedAt] = useState<number>(() => Date.now());

  useEffect(() => {
    setPageTitle(`${t("homeCuration.title")} · Seyirlik`, {
      canonicalPath: "/dev/home-curation",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let isMounted = true;

    async function loadItems() {
      setError(null);

      try {
        const [carouselResult, latestResult] = await Promise.allSettled([
          getAllMovieAndSeriesItems(),
          getLatestMediaItems(),
        ]);

        if (!isMounted) {
          return;
        }

        if (
          carouselResult.status === "rejected" &&
          latestResult.status === "rejected"
        ) {
          throw carouselResult.reason;
        }

        setData({
          carouselItems:
            carouselResult.status === "fulfilled" ? carouselResult.value : [],
          latestItems:
            latestResult.status === "fulfilled" ? latestResult.value : [],
        });
      } catch (loadError) {
        if (!isMounted) {
          return;
        }

        setError(
          loadError instanceof Error
            ? loadError.message
            : t("homeCuration.loadFailed"),
        );
      }
    }

    void loadItems();

    return () => {
      isMounted = false;
    };
  }, [t]);

  useEffect(() => {
    saveHomeCurationPreferences(preferences);
    setSavedAt(Date.now());
  }, [preferences]);

  const carouselItems = useMemo(() => {
    return data
      ? orderHomeCarouselItemsForEditor(
          buildHomeCarouselPool(data.carouselItems),
          preferences,
        )
      : [];
  }, [data, preferences]);
  const carouselItemIds = carouselItems.map((item) => item.Id);
  const latestItems = useMemo(() => {
    return data
      ? orderLatestMediaItemsForEditor(data.latestItems, preferences)
      : [];
  }, [data, preferences]);
  const latestItemIds = latestItems.map((item) => item.Id);
  const filteredCarouselItems = carouselItems.filter((item) =>
    itemMatchesQuery(item, query, t),
  );
  const filteredLatestItems = latestItems.filter((item) =>
    itemMatchesQuery(item, query, t),
  );
  const hiddenCarouselCount = carouselItems.filter((item) =>
    preferences.carouselExcludedIds.includes(item.Id),
  ).length;
  const hiddenLatestCount = latestItems.filter((item) =>
    preferences.latestExcludedIds.includes(item.Id),
  ).length;
  const savedTime = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(savedAt);

  const updatePreferences = (
    updater: (current: HomeCurationPreferences) => HomeCurationPreferences,
  ) => {
    setPreferences((current) => updater(current));
  };

  const resetPreferences = () => {
    clearHomeCurationPreferences();
    setPreferences(DEFAULT_HOME_CURATION_PREFERENCES);
  };

  const moveCarouselItem = (itemId: string, direction: -1 | 1) => {
    updatePreferences((current) => ({
      ...current,
      carouselOrderIds: moveItemId(carouselItemIds, itemId, direction),
    }));
  };

  const moveCarouselItemToIndex = (itemId: string, targetIndex: number) => {
    updatePreferences((current) => ({
      ...current,
      carouselOrderIds: moveItemIdToIndex(carouselItemIds, itemId, targetIndex),
    }));
  };

  const moveLatestItem = (itemId: string, direction: -1 | 1) => {
    updatePreferences((current) => ({
      ...current,
      latestOrderIds: moveItemId(latestItemIds, itemId, direction),
    }));
  };

  const moveLatestItemToIndex = (itemId: string, targetIndex: number) => {
    updatePreferences((current) => ({
      ...current,
      latestOrderIds: moveItemIdToIndex(latestItemIds, itemId, targetIndex),
    }));
  };

  if (error) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorMessage title={t("homeCuration.unavailable")} message={error} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <LoadingSpinner />
          <p className="mt-4 text-sm font-semibold text-white/50">
            {t("homeCuration.loading")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] p-6 shadow-2xl backdrop-blur-xl">
        <Link
          to="/dev"
          className="inline-flex items-center gap-2 text-sm font-black text-white/55 transition hover:text-white"
        >
          <ArrowLeft size={16} />
          {t("devtools.backToDevtools")}
        </Link>

        <div className="mt-5 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
              {t("homeCuration.eyebrow")}
            </p>
            <h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">
              {t("homeCuration.title")}
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-white/55">
              {t("homeCuration.description")}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 text-xs font-black uppercase tracking-[0.12em] text-white/42">
            <span className="rounded-full border border-white/10 bg-black/24 px-3 py-2">
              {formatTemplate(t("homeCuration.carouselSummary"), {
                visible: Math.max(
                  carouselItems.length - hiddenCarouselCount,
                  0,
                ),
                hidden: hiddenCarouselCount,
              })}
            </span>
            <span className="rounded-full border border-white/10 bg-black/24 px-3 py-2">
              {formatTemplate(t("homeCuration.latestSummary"), {
                visible: Math.max(latestItems.length - hiddenLatestCount, 0),
                hidden: hiddenLatestCount,
              })}
            </span>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setActiveSection("carousel")}
          className={`rounded-2xl border p-4 text-left transition ${
            activeSection === "carousel"
              ? "border-[var(--accent)]/50 bg-[var(--accent)]/12"
              : "border-white/10 bg-black/24 hover:bg-white/[0.06]"
          }`}
        >
          <span className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/10 text-white">
              <ListOrdered size={19} />
            </span>
            <span>
              <span className="block text-lg font-black text-white">
                {t("homeCuration.carouselTab")}
              </span>
              <span className="mt-1 block text-sm font-semibold text-white/48">
                {t("homeCuration.carouselTabDescription")}
              </span>
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveSection("latest")}
          className={`rounded-2xl border p-4 text-left transition ${
            activeSection === "latest"
              ? "border-[var(--accent)]/50 bg-[var(--accent)]/12"
              : "border-white/10 bg-black/24 hover:bg-white/[0.06]"
          }`}
        >
          <span className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/10 text-white">
              <Sparkles size={19} />
            </span>
            <span>
              <span className="block text-lg font-black text-white">
                {t("homeCuration.latestTab")}
              </span>
              <span className="mt-1 block text-sm font-semibold text-white/48">
                {t("homeCuration.latestTabDescription")}
              </span>
            </span>
          </span>
        </button>
      </section>

      <section className="rounded-3xl border border-white/10 bg-black/30 p-4 shadow-2xl backdrop-blur-xl sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <label className="relative block flex-1">
            <Search
              size={18}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/35"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("homeCuration.searchPlaceholder")}
              aria-label={t("homeCuration.searchLabel")}
              className="min-h-12 w-full rounded-2xl border border-white/10 bg-white/[0.06] pl-11 pr-4 text-sm font-semibold text-white outline-none transition placeholder:text-white/32 focus:border-[var(--accent)]/55 focus:bg-white/[0.09]"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <p className="px-1 text-xs font-bold text-white/38">
              {formatTemplate(t("homeCuration.savedAt"), { time: savedTime })}
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={resetPreferences}
              className="rounded-full"
            >
              <RotateCcw size={16} />
              {t("homeCuration.resetAll")}
            </Button>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {activeSection === "carousel" ? (
            filteredCarouselItems.length > 0 ? (
              filteredCarouselItems.map((item) => {
                const isEnabled = !preferences.carouselExcludedIds.includes(
                  item.Id,
                );
                const itemIndex = carouselItemIds.indexOf(item.Id);

                return (
                  <CurationItemRow
                    key={item.Id}
                    item={item}
                    enabled={isEnabled}
                    enabledLabel={t("homeCuration.inCarousel")}
                    disabledLabel={t("homeCuration.outOfCarousel")}
                    toggleLabel={
                      isEnabled
                        ? t("homeCuration.excludeFromCarousel")
                        : t("homeCuration.includeInCarousel")
                    }
                    onToggle={() =>
                      updatePreferences((current) => ({
                        ...current,
                        carouselExcludedIds: toggleId(
                          current.carouselExcludedIds,
                          item.Id,
                        ),
                      }))
                    }
                    canMoveToTop={itemIndex > 0}
                    canMoveUp={itemIndex > 0}
                    canMoveDown={
                      itemIndex >= 0 && itemIndex < carouselItemIds.length - 1
                    }
                    canMoveToBottom={
                      itemIndex >= 0 && itemIndex < carouselItemIds.length - 1
                    }
                    onMoveToTop={() => moveCarouselItemToIndex(item.Id, 0)}
                    onMoveUp={() => moveCarouselItem(item.Id, -1)}
                    onMoveDown={() => moveCarouselItem(item.Id, 1)}
                    onMoveToBottom={() =>
                      moveCarouselItemToIndex(
                        item.Id,
                        carouselItemIds.length - 1,
                      )
                    }
                  />
                );
              })
            ) : (
              <p className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-sm font-semibold text-white/48">
                {t("homeCuration.noMatches")}
              </p>
            )
          ) : filteredLatestItems.length > 0 ? (
            filteredLatestItems.map((item) => {
              const isEnabled = !preferences.latestExcludedIds.includes(
                item.Id,
              );
              const itemIndex = latestItemIds.indexOf(item.Id);

              return (
                <CurationItemRow
                  key={item.Id}
                  item={item}
                  enabled={isEnabled}
                  enabledLabel={t("homeCuration.inLatest")}
                  disabledLabel={t("homeCuration.outOfLatest")}
                  toggleLabel={
                    isEnabled
                      ? t("homeCuration.excludeFromLatest")
                      : t("homeCuration.includeInLatest")
                  }
                  onToggle={() =>
                    updatePreferences((current) => ({
                      ...current,
                      latestExcludedIds: toggleId(
                        current.latestExcludedIds,
                        item.Id,
                      ),
                    }))
                  }
                  canMoveToTop={itemIndex > 0}
                  canMoveUp={itemIndex > 0}
                  canMoveDown={
                    itemIndex >= 0 && itemIndex < latestItemIds.length - 1
                  }
                  canMoveToBottom={
                    itemIndex >= 0 && itemIndex < latestItemIds.length - 1
                  }
                  onMoveToTop={() => moveLatestItemToIndex(item.Id, 0)}
                  onMoveUp={() => moveLatestItem(item.Id, -1)}
                  onMoveDown={() => moveLatestItem(item.Id, 1)}
                  onMoveToBottom={() =>
                    moveLatestItemToIndex(item.Id, latestItemIds.length - 1)
                  }
                />
              );
            })
          ) : (
            <p className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-sm font-semibold text-white/48">
              {t("homeCuration.noMatches")}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
