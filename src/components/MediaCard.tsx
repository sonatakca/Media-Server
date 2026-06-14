import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router-dom";
import { Info, RotateCcw } from "lucide-react";
import { getLogoImageUrl, getPrimaryImageUrl } from "../lib/jellyfinApi";
import { getDisplayTitle, getItemSubtitle } from "../lib/format";
import type { JellyfinItem } from "../lib/types";
import { getItemProgressPercent, isItemCompleted } from "../lib/watchStatus";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";
import { ClearWatchingButton } from "./ClearWatchingButton";
import { CollectionPosterMosaic } from "./CollectionPosterMosaic";
import { RestartWatchingButton } from "./RestartWatchingButton";
import { WatchedIndicator } from "./WatchedIndicator";
import { WatchedStatusButton } from "./WatchedStatusButton";
import { Tooltip } from "./ui/Tooltip";

interface MediaCardProps {
  item: JellyfinItem;
  to: string;
  variant?: "poster" | "landscape";
  layout?: "row" | "grid";
  index?: number;
  animateIn?: boolean;
  showPlayFromBeginning?: boolean;
  showRestartWatching?: boolean;
  collectionItems?: JellyfinItem[];
  onClearContinueWatching?: (item: JellyfinItem) => void;
  onWatchedStatusReset?: (items: JellyfinItem[]) => void;
}

function getEpisodeDisplayTitle(
  item: JellyfinItem,
  t: (key: TranslationKey) => string,
): string | null {
  if (item.Type !== "Episode") {
    return null;
  }

  if (typeof item.IndexNumber === "number" && item.IndexNumber > 0) {
    return formatTemplate(t("media.episodeCardTitle"), {
      number: item.IndexNumber,
    });
  }

  return item.Name || null;
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

function getCountLabel(
  item: JellyfinItem,
  t: (key: TranslationKey) => string,
): string | null {
  if (item.Type === "Series") {
    const parts: string[] = [];

    if (typeof item.ChildCount === "number" && item.ChildCount > 0) {
      parts.push(
        countLabel(
          item.ChildCount,
          "media.seasonSingular",
          "media.seasonPlural",
          t,
        ),
      );
    }

    if (
      typeof item.RecursiveItemCount === "number" &&
      item.RecursiveItemCount > 0
    ) {
      parts.push(
        countLabel(
          item.RecursiveItemCount,
          "media.episodeSingular",
          "media.episodePlural",
          t,
        ),
      );
    }

    return parts.length > 0 ? parts.join(" · ") : null;
  }

  if (item.Type === "Season") {
    const seasonLabel =
      typeof item.IndexNumber === "number" && item.IndexNumber > 0
        ? formatTemplate(t("media.seasonNumber"), { number: item.IndexNumber })
        : item.Name;

    const episodeCount =
      typeof item.ChildCount === "number" && item.ChildCount > 0
        ? item.ChildCount
        : typeof item.RecursiveItemCount === "number" &&
            item.RecursiveItemCount > 0
          ? item.RecursiveItemCount
          : null;

    if (!episodeCount) {
      return seasonLabel;
    }

    const episodeLabel = countLabel(
      episodeCount,
      "media.episodeSingular",
      "media.episodePlural",
      t,
    );

    return `${seasonLabel} · ${episodeLabel}`;
  }

  return null;
}

export function MediaCard({
  item,
  to,
  variant = "poster",
  layout = "row",
  index = 0,
  animateIn = false,
  showPlayFromBeginning = false,
  showRestartWatching = false,
  collectionItems,
  onClearContinueWatching,
  onWatchedStatusReset,
}: MediaCardProps) {
  const { t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const mediaFormatLabels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };

  const [imageFailed, setImageFailed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [shouldUseShowPrimaryImage, setShouldUseShowPrimaryImage] =
    useState(false);

  const title = getDisplayTitle(item, mediaFormatLabels);
  const isEpisode = item.Type === "Episode";
  const episodeNumberLabel = isEpisode ? getEpisodeDisplayTitle(item, t) : null;
  const isSeasonEpisodeGrid =
    isEpisode && layout === "grid" && variant === "landscape";
  const episodeDisplayTitle = isSeasonEpisodeGrid
    ? episodeNumberLabel
    : isEpisode
      ? item.Name || null
      : null;
  const displayTitle = episodeDisplayTitle ?? title;

  const itemCounts = getCountLabel(item, t);
  const progressPercent = getItemProgressPercent(item);
  const isWatched = isItemCompleted(item);

  const imageUrl = item.ImageTags?.Primary
    ? getPrimaryImageUrl(
        item.Id,
        item.ImageTags.Primary,
        variant === "poster" ? 720 : 1100,
      )
    : "";
  const showPrimaryImageUrl =
    item.Type === "Episode" && item.SeriesId && item.SeriesPrimaryImageTag
      ? getPrimaryImageUrl(item.SeriesId, item.SeriesPrimaryImageTag, 720)
      : "";
  const displayImageUrl =
    shouldUseShowPrimaryImage && showPrimaryImageUrl
      ? showPrimaryImageUrl
      : imageUrl;
  const logoUrl =
    item.Type === "Episode" && isSeasonEpisodeGrid
      ? ""
      : item.ImageTags?.Logo
        ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 700)
        : item.ParentLogoItemId && item.ParentLogoImageTag
          ? getLogoImageUrl(item.ParentLogoItemId, item.ParentLogoImageTag, 700)
          : "";

  const canPlay =
    item.Type === "Movie" ||
    item.Type === "Episode" ||
    item.MediaType === "Video";
  const primaryCardTo = canPlay ? `/watch/${item.Id}` : to;

  const isLandscape = variant === "landscape" || isEpisode;
  const isGrid = layout === "grid";

  const sizeClass = isGrid
    ? "w-full"
    : isLandscape
      ? "w-60 sm:w-80 lg:w-96"
      : "w-36 sm:w-52 lg:w-60";

  const aspectClass = isEpisode
    ? ""
    : isLandscape
      ? "aspect-video"
      : "aspect-[2/3]";

  const entranceDelay = Math.min(index * 0.025, 0.18);
  const motionProps = animateIn
    ? shouldReduceMotion
      ? {
          initial: { opacity: 0 },
          whileInView: { opacity: 1 },
          viewport: { once: true, margin: "80px" },
          transition: { duration: 0.01 },
        }
      : {
          initial: { opacity: 0, y: 14, scale: 0.985 },
          whileInView: { opacity: 1, y: 0, scale: 1 },
          viewport: { once: true, margin: "80px" },
          transition: {
            duration: 0.3,
            delay: entranceDelay,
            ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
          },
        }
    : {};

  const renderContentByType = () => {
    if (item.Type === "Season") {
      return (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col p-3 sm:p-4 bg-gradient-to-t from-black/95 via-black/40 to-transparent">
          <h3 className="mb-1 line-clamp-1 text-base font-bold text-white sm:text-lg">
            {displayTitle}
          </h3>
          {itemCounts && (
            <p className="line-clamp-1 text-[0.7rem] font-medium text-gray-300 sm:text-sm">
              {itemCounts}
            </p>
          )}
        </div>
      );
    }

    if (item.Type === "BoxSet" || collectionItems?.length) {
      return (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center p-3 sm:p-4 bg-black/60 transition-colors group-hover:bg-black/40">
          <h3 className="text-center text-lg font-black text-white sm:text-xl drop-shadow-lg">
            {displayTitle}
          </h3>
          {itemCounts && (
            <p className="mt-2 rounded-full bg-white/20 px-3 py-1 text-xs font-bold text-white backdrop-blur-md">
              {itemCounts}
            </p>
          )}
        </div>
      );
    }

    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col p-3 sm:p-4 bg-gradient-to-t from-black/95 via-black/40 to-transparent">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={displayTitle}
            className="mb-2 h-auto max-h-16 w-auto object-contain object-left sm:max-h-24"
          />
        ) : (
          <h3 className="mb-1 line-clamp-1 text-sm font-bold text-white sm:text-base">
            {displayTitle}
          </h3>
        )}
        {itemCounts && (
          <p className="mb-1 line-clamp-1 text-[0.7rem] font-bold text-white sm:text-sm">
            {itemCounts}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.68rem] font-semibold text-white/75 sm:text-xs">
          {item.ProductionYear && (
            <span className="rounded-full bg-white/10 px-2 py-0.5">
              {item.ProductionYear}
            </span>
          )}
          {item.OfficialRating && (
            <span className="rounded-full bg-white/10 px-2 py-0.5">
              {item.OfficialRating}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <motion.div
      className={`h-full min-w-0 shrink-0 ${sizeClass}`}
      whileTap={shouldReduceMotion ? undefined : { scale: 0.985 }}
      {...motionProps}
    >
      <div
        className={`media-card-cinematic group relative h-full w-full min-w-0 scroll-ml-4 transform-gpu overflow-hidden rounded-xl border bg-[var(--surface)] shadow-cinematic-card transition-[border-color,box-shadow,transform] duration-300 will-change-transform hover:z-10 hover:border-white/20 hover:shadow-cinematic-card-hover motion-reduce:hover:translate-y-0 motion-reduce:hover:scale-100 ${
          isEpisode
            ? "flex flex-col hover:-translate-y-1"
            : `block ${aspectClass} hover:-translate-y-1.5 hover:scale-[1.025]`
        } ${
          isWatched
            ? "border-emerald-300/70 ring-2 ring-emerald-300/45 shadow-[0_0_0_1px_rgba(52,211,153,0.28),0_22px_60px_rgba(16,185,129,0.2)]"
            : "border-white/10"
        }`}
      >
        <Link
          to={primaryCardTo}
          aria-label={`${t("common.details")} ${title}`}
          className="absolute inset-0 z-30 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />

        <div
          className={
            isEpisode
              ? "pointer-events-none relative z-0 aspect-video w-full shrink-0 overflow-hidden bg-zinc-950"
              : "pointer-events-none absolute inset-0 z-0 overflow-hidden bg-zinc-900"
          }
        >
          {!imageLoaded && displayImageUrl && !imageFailed ? (
            <div className="shimmer absolute inset-0" />
          ) : null}
          {displayImageUrl && !imageFailed ? (
            <img
              src={displayImageUrl}
              alt={title}
              loading="lazy"
              className={`relative z-10 h-full w-full transition-[transform,opacity] duration-500 ${
                isEpisode
                  ? "object-contain"
                  : "object-cover group-hover:scale-[1.04] group-focus-within:scale-[1.08]"
              } ${imageLoaded ? "opacity-100" : "opacity-0"}`}
              onLoad={(event) => {
                const image = event.currentTarget;
                const imageAspectRatio =
                  image.naturalWidth / image.naturalHeight;
                if (
                  item.Type === "Episode" &&
                  variant === "poster" &&
                  !shouldUseShowPrimaryImage &&
                  showPrimaryImageUrl &&
                  imageAspectRatio > 1.2
                ) {
                  setImageLoaded(false);
                  setShouldUseShowPrimaryImage(true);
                  return;
                }
                setImageLoaded(true);
              }}
              onError={() => setImageFailed(true)}
            />
          ) : collectionItems?.length ? (
            <CollectionPosterMosaic
              title={title}
              items={collectionItems}
              imageSize={variant === "poster" ? 520 : 760}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(145deg,#27272a,#09090b)] p-5 text-center text-sm font-bold text-zinc-100">
              {displayTitle}
            </div>
          )}
        </div>

        <div className="absolute right-3 top-3 z-30 sm:right-4 sm:top-4">
          <WatchedIndicator
            item={item}
            className="px-2 py-0.5 text-[0.56rem] tracking-[0.14em] sm:px-2.5 sm:py-1 sm:text-[0.62rem]"
            iconSize={12}
          />
        </div>

        {isEpisode ? (
          <div className="pointer-events-none relative isolate z-20 flex min-h-[8.5rem] flex-col overflow-hidden border-t border-white/16 bg-black/40 px-4 pb-4 pt-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] sm:min-h-[9.75rem] sm:px-5 sm:pb-5 sm:pt-4 transform-gpu [backface-visibility:hidden]">
            {displayImageUrl && !imageFailed ? (
              <img
                src={displayImageUrl}
                alt=""
                aria-hidden="true"
                className="absolute inset-x-0 top-0 -z-30 h-auto w-full -scale-y-100 object-contain opacity-60 blur-[30px] transform-gpu [backface-visibility:hidden]"
              />
            ) : null}

            <div className="absolute inset-x-0 top-0 -z-[5] h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />

            {episodeNumberLabel ? (
              <span className="mb-1 truncate text-[0.66rem] font-black uppercase tracking-[0.08em] text-white/95 sm:text-xs">
                {episodeNumberLabel}
              </span>
            ) : null}

            <h3 className="line-clamp-1 text-sm font-bold text-white sm:text-base">
              {item.Name}
            </h3>

            {item.Overview ? (
              <p className="mt-1.5 line-clamp-2 text-[0.7rem] font-medium leading-[1.35] text-white/78 sm:text-xs">
                {item.Overview}
              </p>
            ) : null}

            <div className="mt-auto flex items-end justify-between gap-3 pt-2">
              {item.RunTimeTicks ? (
                <span className="flex items-center gap-1.5 text-[0.7rem] font-semibold text-white/75 sm:text-xs">
                  <svg
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                  {Math.round(item.RunTimeTicks / 600000000)} dk
                </span>
              ) : (
                <span />
              )}

              <svg
                aria-hidden="true"
                className="h-4 w-4 text-white/60"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM22 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
              </svg>
            </div>
          </div>
        ) : (
          renderContentByType()
        )}

        {progressPercent !== null ? (
          <div className="absolute inset-x-0 bottom-0 z-30 h-1 sm:h-1.5 bg-white/[0.18]">
            <div
              data-testid="media-card-progress-fill"
              className="h-full bg-[var(--accent)]"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        ) : null}

        <div className="absolute inset-0 z-40 pointer-events-none">
          {canPlay && onClearContinueWatching ? (
            <ClearWatchingButton
              item={item}
              onCleared={onClearContinueWatching}
              className="pointer-events-auto absolute right-3 top-3 flex h-9 w-9 shrink-0 -translate-y-1 items-center justify-center rounded-full border border-white/15 bg-gray-600/90 text-white opacity-0 shadow-player-controls transition duration-300 hover:bg-gray-500 focus:translate-y-0 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
            />
          ) : null}
          {canPlay && onWatchedStatusReset ? (
            <WatchedStatusButton
              scope="item"
              action={isWatched ? "remove" : "mark"}
              item={item}
              onReset={onWatchedStatusReset}
              className={`pointer-events-auto absolute flex h-10 w-10 shrink-0 translate-y-1 items-center justify-center rounded-full border border-white/15 bg-gray-600/90 text-white opacity-0 shadow-player-controls transition duration-500 hover:bg-gray-500 focus:translate-y-0 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:-translate-y-3 group-hover:opacity-100 group-focus-within:-translate-y-3 group-focus-within:opacity-100 ${onClearContinueWatching ? "right-3 top-5" : "left-3 top-5"}`}
            />
          ) : null}
          {canPlay && showRestartWatching ? (
            <RestartWatchingButton
              item={item}
              className="pointer-events-auto absolute left-3 top-3 flex h-10 w-10 shrink-0 translate-y-1 items-center justify-center rounded-full border border-white/15 bg-gray-600/90 text-white opacity-0 shadow-player-controls transition duration-500 hover:bg-gray-500 focus:translate-y-0 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:-translate-y-3 group-hover:opacity-100 group-focus-within:-translate-y-3 group-focus-within:opacity-100"
            />
          ) : null}
          {canPlay && showPlayFromBeginning && progressPercent !== null ? (
            <Tooltip content={t("details.playFromBeginning")}>
              <Link
                to={`/watch/${item.Id}?start=0`}
                aria-label={formatTemplate(
                  t("details.playTitleFromBeginning"),
                  { title },
                )}
                className="pointer-events-auto absolute left-3 top-3 flex h-10 w-10 shrink-0 translate-y-1 items-center justify-center rounded-full border border-white/15 bg-gray-600/90 text-white opacity-0 shadow-player-controls transition duration-500 hover:bg-gray-500 focus:translate-y-0 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:-translate-y-3 group-hover:opacity-100 group-focus-within:-translate-y-3 group-focus-within:opacity-100"
              >
                <RotateCcw size={16} />
              </Link>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}
