import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatTemplate } from "../../lib/format";
import type {
  PlaybackQueue,
  PlaybackQueueSeason,
} from "../../lib/playbackQueue";
import type { JellyfinItem } from "../../lib/types";
import {
  QueueItemButton,
  type PlayerQueueTranslate,
} from "./PlayerQueueItemButton";

interface PlayerQueuePanelProps {
  queue: PlaybackQueue;
  compact?: boolean;
  onPlayItem?: (item: JellyfinItem) => void;
}

function getSeasonLabel(season: PlaybackQueueSeason, t: PlayerQueueTranslate) {
  if (season.seasonNumber !== null) {
    return formatTemplate(t("media.seasonNumber"), {
      number: season.seasonNumber,
    });
  }

  return season.name ?? t("player.seasonSelect");
}

function getQueueTitle(queue: PlaybackQueue, t: PlayerQueueTranslate) {
  return queue.kind === "series"
    ? t("player.queueEpisodes")
    : t("player.queueCollection");
}

export function PlayerQueuePanel({
  queue,
  compact = false,
  onPlayItem,
}: PlayerQueuePanelProps) {
  const { t } = useLanguage();
  const seasons = queue.seasons ?? [];
  const defaultSeasonId = queue.currentSeasonId ?? seasons[0]?.id ?? "";
  const [selectedSeasonId, setSelectedSeasonId] = useState(defaultSeasonId);
  const [isSeasonMenuOpen, setIsSeasonMenuOpen] = useState(false);
  const [isCollectionScrollable, setIsCollectionScrollable] = useState(false);
  const [canScrollCollectionLeft, setCanScrollCollectionLeft] = useState(false);
  const [canScrollCollectionRight, setCanScrollCollectionRight] =
    useState(false);
  const collectionScrollRef = useRef<HTMLDivElement | null>(null);
  const episodeScrollRef = useRef<HTMLDivElement | null>(null);
  const selectedSeason =
    seasons.find((season) => season.id === selectedSeasonId) ?? seasons[0];
  const visibleItems =
    queue.kind === "series" ? (selectedSeason?.episodes ?? []) : queue.items;
  const panelWidthClass = compact
    ? queue.kind === "collection"
      ? "sm:w-fit sm:max-w-md"
      : "sm:w-72 sm:max-w-[calc(100vw-2rem)]"
    : queue.kind === "collection"
      ? "sm:w-fit sm:max-w-2xl"
      : "sm:w-80 sm:max-w-[calc(100vw-2rem)]";

  useEffect(() => {
    setSelectedSeasonId(defaultSeasonId);
  }, [defaultSeasonId]);

  useLayoutEffect(() => {
    if (queue.kind !== "collection") {
      setIsCollectionScrollable(false);
      setCanScrollCollectionLeft(false);
      setCanScrollCollectionRight(false);
      return;
    }

    const scrollContainer = collectionScrollRef.current;

    if (!scrollContainer) {
      setIsCollectionScrollable(false);
      setCanScrollCollectionLeft(false);
      setCanScrollCollectionRight(false);
      return;
    }

    const updateScrollableState = () => {
      const maxScrollLeft = Math.max(
        0,
        scrollContainer.scrollWidth - scrollContainer.clientWidth,
      );
      const isScrollable = maxScrollLeft > 1;

      setIsCollectionScrollable(isScrollable);
      setCanScrollCollectionLeft(
        isScrollable && scrollContainer.scrollLeft > 1,
      );
      setCanScrollCollectionRight(
        isScrollable && scrollContainer.scrollLeft < maxScrollLeft - 1,
      );
    };

    updateScrollableState();

    scrollContainer.addEventListener("scroll", updateScrollableState, {
      passive: true,
    });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateScrollableState);

      return () => {
        scrollContainer.removeEventListener("scroll", updateScrollableState);
        window.removeEventListener("resize", updateScrollableState);
      };
    }

    const resizeObserver = new ResizeObserver(updateScrollableState);
    resizeObserver.observe(scrollContainer);

    Array.from(scrollContainer.children).forEach((child) => {
      resizeObserver.observe(child);
    });

    return () => {
      scrollContainer.removeEventListener("scroll", updateScrollableState);
      resizeObserver.disconnect();
    };
  }, [queue.kind, visibleItems.length]);

  useLayoutEffect(() => {
    const currentItemId = queue.currentItemId;

    if (!currentItemId) {
      return;
    }

    const scrollContainer =
      queue.kind === "collection"
        ? collectionScrollRef.current
        : episodeScrollRef.current;

    if (!scrollContainer) {
      return;
    }

    const currentElement = scrollContainer.querySelector<HTMLElement>(
      `[data-queue-item-id="${CSS.escape(currentItemId)}"]`,
    );

    if (!currentElement) {
      return;
    }

    const containerRect = scrollContainer.getBoundingClientRect();
    const elementRect = currentElement.getBoundingClientRect();

    if (queue.kind === "collection") {
      scrollContainer.scrollLeft += elementRect.left - containerRect.left;
      return;
    }

    scrollContainer.scrollTop += elementRect.top - containerRect.top;
  }, [queue.kind, queue.currentItemId, selectedSeasonId, visibleItems.length]);

  const scrollCollection = (direction: "left" | "right") => {
    const scrollContainer = collectionScrollRef.current;

    if (!scrollContainer) {
      return;
    }

    const firstItem = scrollContainer.querySelector<HTMLElement>(
      "[data-queue-item-id]",
    );
    const itemWidth = firstItem?.offsetWidth ?? 160;
    const gap = 12;
    const scrollAmount = Math.max(
      itemWidth + gap,
      scrollContainer.clientWidth * 0.72,
    );

    scrollContainer.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });

    window.setTimeout(() => {
      const maxScrollLeft = Math.max(
        0,
        scrollContainer.scrollWidth - scrollContainer.clientWidth,
      );
      const isScrollable = maxScrollLeft > 1;

      setIsCollectionScrollable(isScrollable);
      setCanScrollCollectionLeft(
        isScrollable && scrollContainer.scrollLeft > 1,
      );
      setCanScrollCollectionRight(
        isScrollable && scrollContainer.scrollLeft < maxScrollLeft - 1,
      );
    }, 220);
  };

  return (
    <div
      className={`fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+4.25rem)] z-[70] overflow-visible rounded-2xl border border-white/10 bg-[rgba(18,18,20,0.96)] p-4 pr-2 text-white shadow-[0_24px_90px_rgba(0,0,0,0.72)] backdrop-blur-2xl sm:absolute sm:inset-x-auto sm:bottom-[5.25rem] sm:right-0 ${panelWidthClass}`}
    >
      {queue.kind === "collection" && isCollectionScrollable ? (
        <>
          <button
            type="button"
            aria-label="Scroll queue left"
            onClick={() => scrollCollection("left")}
            disabled={!canScrollCollectionLeft}
            className="absolute -left-11 top-1/2 z-[85] flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-gray-500 text-white shadow-player-controls transition hover:bg-gray-400 focus:outline-none focus:ring-2 focus:ring-white/70 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-gray-700 disabled:text-white/35 disabled:shadow-none disabled:hover:bg-gray-700"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>

          <button
            type="button"
            aria-label="Scroll queue right"
            onClick={() => scrollCollection("right")}
            disabled={!canScrollCollectionRight}
            className="absolute -right-11 top-1/2 z-[85] flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-gray-500 text-white shadow-player-controls transition hover:bg-gray-400 focus:outline-none focus:ring-2 focus:ring-white/70 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-gray-700 disabled:text-white/35 disabled:shadow-none disabled:hover:bg-gray-700"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-[var(--accent)]">
          {getQueueTitle(queue, t)}
        </p>

        {queue.kind === "series" && seasons.length > 0 ? (
          <label className="sr-only" htmlFor="player-season-select">
            {t("player.seasonSelect")}
          </label>
        ) : null}
      </div>

      {queue.kind === "series" && seasons.length > 0 ? (
        <div className="relative mt-3">
          <button
            id="player-season-select"
            type="button"
            onClick={() => setIsSeasonMenuOpen((open) => !open)}
            aria-haspopup="listbox"
            aria-expanded={isSeasonMenuOpen}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.08] px-3 py-2 text-left text-sm font-black text-white outline-none transition hover:border-white/20 hover:bg-white/[0.12] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]"
          >
            <span className="truncate">
              {selectedSeason
                ? getSeasonLabel(selectedSeason, t)
                : t("player.seasonSelect")}
            </span>

            <ChevronDown
              className={`h-4 w-4 shrink-0 text-white/60 transition-transform ${
                isSeasonMenuOpen ? "rotate-180" : ""
              }`}
            />
          </button>

          {isSeasonMenuOpen ? (
            <div
              role="listbox"
              aria-labelledby="player-season-select"
              className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-[90] max-h-56 overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/95 p-1 shadow-[0_18px_60px_rgba(0,0,0,0.65)] backdrop-blur-2xl"
            >
              {seasons.map((season) => {
                const isSelected = season.id === selectedSeason?.id;

                return (
                  <button
                    key={season.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      setSelectedSeasonId(season.id);
                      setIsSeasonMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-bold transition ${
                      isSelected
                        ? "bg-[var(--accent)]/18 text-[var(--accent)]"
                        : "text-white/80 hover:bg-white/[0.08] hover:text-white"
                    }`}
                  >
                    <span className="truncate">
                      {getSeasonLabel(season, t)}
                    </span>

                    {isSelected ? <Check className="h-4 w-4 shrink-0" /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {queue.kind === "collection" ? (
        <div className="mt-3">
          <div
            ref={collectionScrollRef}
            className={`media-scroll flex w-max max-w-full gap-3 overflow-y-hidden pb-2 pt-1 ${
              isCollectionScrollable ? "overflow-x-auto" : "overflow-x-hidden"
            }`}
          >
            {visibleItems.map((item) => (
              <div
                key={item.Id}
                data-queue-item-id={item.Id}
                className="shrink-0"
              >
                <QueueItemButton
                  item={item}
                  isCurrent={item.Id === queue.currentItemId}
                  variant="collection"
                  t={t}
                  onPlayItem={onPlayItem}
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div
          ref={episodeScrollRef}
          className="player-queue-scroll mt-3 max-h-[min(25rem,calc(100dvh-14rem))] space-y-2 overflow-y-auto pr-2"
        >
          {visibleItems.map((item) => (
            <div key={item.Id} data-queue-item-id={item.Id}>
              <QueueItemButton
                item={item}
                isCurrent={item.Id === queue.currentItemId}
                variant="episode"
                t={t}
                onPlayItem={onPlayItem}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
