import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { Eye, Pause } from "lucide-react";
import type { TranslationKey } from "../../i18n/translations";
import { formatTemplate } from "../../lib/format";
import { getPrimaryImageUrl } from "../../lib/jellyfinApi";
import type { JellyfinItem } from "../../lib/types";
import { isItemCompleted } from "../../lib/watchStatus";
import { Tooltip } from "../ui/Tooltip";

export type PlayerQueueTranslate = (key: TranslationKey) => string;
export type QueueItemVariant = "episode" | "collection";

interface QueueItemButtonProps {
  item: JellyfinItem;
  isCurrent: boolean;
  variant: QueueItemVariant;
  t: PlayerQueueTranslate;
  onPlayItem?: (item: JellyfinItem) => void;
}

function getReleaseYear(item: JellyfinItem): number | null {
  if (typeof item.ProductionYear === "number") {
    return item.ProductionYear;
  }

  if (!item.PremiereDate) {
    return null;
  }

  const releaseDate = new Date(item.PremiereDate);
  const releaseYear = releaseDate.getUTCFullYear();

  return Number.isFinite(releaseYear) ? releaseYear : null;
}

function getThumbnailUrl(item: JellyfinItem): string {
  return item.ImageTags?.Primary
    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 400)
    : "";
}

function getPosterUrl(item: JellyfinItem): string {
  return item.ImageTags?.Primary
    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 500)
    : "";
}

function getEpisodeLabel(item: JellyfinItem, t: PlayerQueueTranslate) {
  if (
    typeof item.ParentIndexNumber === "number" &&
    typeof item.IndexNumber === "number"
  ) {
    return formatTemplate(t("media.seasonEpisodeNumber"), {
      seasonNumber: item.ParentIndexNumber,
      episodeNumber: item.IndexNumber,
    });
  }

  return [
    typeof item.ParentIndexNumber === "number"
      ? formatTemplate(t("media.seasonNumber"), {
          number: item.ParentIndexNumber,
        })
      : item.SeasonName,
    typeof item.IndexNumber === "number"
      ? formatTemplate(t("media.episodeNumber"), {
          number: item.IndexNumber,
        })
      : null,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
}

function QueueItemTitle({
  title,
  titleRef,
}: {
  title: string;
  titleRef: Ref<HTMLSpanElement>;
}) {
  return (
    <span className="block w-full min-w-0 overflow-hidden">
      <span
        ref={titleRef}
        className="block w-full min-w-0 truncate whitespace-nowrap text-center text-sm font-black text-white"
      >
        <span className="block" aria-hidden="true" />
        {title}
      </span>
    </span>
  );
}

function WatchedBadge({ label }: { label: string }) {
  return (
    <span className="absolute right-2 top-2 rounded-full border border-white/35 bg-[linear-gradient(135deg,#6ee7b7,#10b981)] px-1 py-1 text-[0.58rem] font-black uppercase tracking-[0.12em] text-emerald-950 shadow-[0_8px_18px_rgba(0,0,0,0.5),0_0_0_1px_rgba(6,78,59,0.35)]">
      <Eye size={15} />
    </span>
  );
}

function CurrentItemIndicator() {
  return (
    <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-white/25 bg-black/75 text-[var(--accent)] shadow-[0_8px_20px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.16)]">
      <Pause className="h-3.5 w-3.5" fill="currentColor" strokeWidth={2.4} />
    </span>
  );
}

export function QueueItemButton({
  item,
  isCurrent,
  variant,
  t,
  onPlayItem,
}: QueueItemButtonProps) {
  const isCollection = variant === "collection";
  const isMoviePoster = isCollection && item.Type === "Movie";
  const episodeLabel =
    item.Type === "Episode" ? getEpisodeLabel(item, t) : null;
  const releaseYear = item.Type === "Movie" ? getReleaseYear(item) : null;
  const imageUrl = isMoviePoster ? getPosterUrl(item) : getThumbnailUrl(item);
  const isWatched = isItemCompleted(item);

  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [isTitleOverflowing, setIsTitleOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = titleRef.current;

    if (!element) {
      return undefined;
    }

    const updateOverflowState = () => {
      setIsTitleOverflowing(element.scrollWidth > element.clientWidth + 1);
    };

    updateOverflowState();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOverflowState);

      return () => {
        window.removeEventListener("resize", updateOverflowState);
      };
    }

    const resizeObserver = new ResizeObserver(updateOverflowState);
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [item.Name, isMoviePoster, isCollection]);

  return (
    <Tooltip
      content={item.Name}
      disabled={!isTitleOverflowing}
      group="player-queue"
      offset="0.65rem"
      placement="bottom"
    >
      <button
        type="button"
        onClick={() => {
          if (!isCurrent) {
            onPlayItem?.(item);
          }
        }}
        aria-disabled={isCurrent ? "true" : undefined}
        aria-current={isCurrent ? "true" : undefined}
        className={`group flex flex-col rounded-xl border p-2 text-center transition focus:outline-none focus:ring-2 focus:ring-[var(--accent)] ${
          isMoviePoster
            ? "min-w-[8.5rem] max-w-[9.5rem] snap-start"
            : isCollection
              ? "min-w-[13.75rem] max-w-[14.75rem] snap-start"
              : "w-full"
        } ${
          isCurrent
            ? "cursor-not-allowed border-[var(--accent)]/45 bg-[var(--accent)]/14 hover:bg-white/[0.10]"
            : "border-white/10 bg-transparent hover:border-white/20 hover:bg-white/[0.10]"
        }`}
      >
        <span
          className={`relative mx-auto shrink-0 overflow-hidden rounded-lg bg-white/[0.06] ${
            isMoviePoster
              ? "aspect-[2/3] w-full"
              : isCollection
                ? "flex h-24 w-full items-center justify-center bg-black/35"
                : "aspect-video w-full max-w-[15rem]"
          }`}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              loading="lazy"
              className={
                isMoviePoster
                  ? "h-full w-full object-cover"
                  : isCollection
                    ? "max-h-full max-w-full object-contain drop-shadow-[0_8px_18px_rgba(0,0,0,0.45)]"
                    : "h-full w-full object-cover"
              }
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-[linear-gradient(145deg,#27272a,#050506)] text-[0.62rem] font-black uppercase tracking-[0.12em] text-white/35">
              No image
            </span>
          )}

          <span
            className={`pointer-events-none absolute inset-0 transition ${
              isMoviePoster || isCollection
                ? "bg-[linear-gradient(180deg,rgba(0,0,0,0.04),rgba(0,0,0,0.24))]"
                : "bg-black/20"
            }`}
          />

          {isCurrent ? <CurrentItemIndicator /> : null}
          {isWatched ? <WatchedBadge label={t("details.watched")} /> : null}
        </span>

        <span
          className={`mt-2 flex w-full min-w-0 flex-col items-center ${
            isCollection ? "" : "mx-auto max-w-[12rem]"
          }`}
        >
          <QueueItemTitle title={item.Name} titleRef={titleRef} />
          {episodeLabel ? (
            <span className="block max-w-full truncate text-center text-[0.68rem] font-black uppercase tracking-[0.12em] text-white/45">
              {episodeLabel}
            </span>
          ) : releaseYear ? (
            <span className="block text-center text-[0.68rem] font-black uppercase tracking-[0.12em] text-white/45">
              {releaseYear}
            </span>
          ) : null}
        </span>
      </button>
    </Tooltip>
  );
}
