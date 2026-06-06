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
  const isSeasonEpisodeGrid =
    item.Type === "Episode" && layout === "grid" && variant === "landscape";

  const episodeDisplayTitle = isSeasonEpisodeGrid
    ? getEpisodeDisplayTitle(item, t)
    : item.Type === "Episode"
      ? item.Name || null
      : null;

  const displayTitle = episodeDisplayTitle ?? title;

  const subtitle =
    item.Type === "Episode"
      ? isSeasonEpisodeGrid
        ? null
        : item.RunTimeTicks
          ? `${Math.round(item.RunTimeTicks / 600000000)} dk`
          : null
      : getItemSubtitle(item, mediaFormatLabels);
  const countLabel = getCountLabel(item, t);
  const progressPercent = getItemProgressPercent(item);
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
  const secondaryLabel =
    item.Type === "Episode"
      ? isSeasonEpisodeGrid
        ? item.Name || null
        : title
      : item.Type === "Season"
        ? null
        : !logoUrl
          ? title
          : null;
  const canPlay =
    item.Type === "Movie" ||
    item.Type === "Episode" ||
    item.MediaType === "Video";
  const isWatched = isItemCompleted(item);
  const detailsLabel = `${t("common.details")} ${title}`;
  const primaryCardTo = canPlay ? `/watch/${item.Id}` : to;
  const primaryCardLabel = canPlay
    ? `${t("common.play")} ${title}`
    : detailsLabel;
  const isLandscape = variant === "landscape";
  const isGrid = layout === "grid";

  const sizeClass = isGrid
    ? "w-full"
    : isLandscape
      ? "w-60 sm:w-80 lg:w-96"
      : "w-36 sm:w-52 lg:w-60";

  const artworkObjectFitClass = "object-cover";

  const panelClass = isGrid
    ? "min-h-[4.8rem] transition-[transform,background-color] duration-500 group-hover:-translate-y-1.5 group-focus-within:-translate-y-1.5 sm:min-h-[5.9rem]"
    : "min-h-[4.8rem] transition-[transform,min-height,background-color] duration-700 group-hover:-translate-y-2.5 group-hover:min-h-[8.2rem] group-focus-within:-translate-y-2.5 group-focus-within:min-h-[8.2rem] sm:min-h-[5.9rem] sm:group-hover:min-h-[10.5rem] sm:group-focus-within:min-h-[10.5rem]";

  const hoverMetaClass = isGrid
    ? "max-h-0 overflow-hidden opacity-0 transition-[max-height,opacity,transform] duration-300 group-hover:max-h-16 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:max-h-16 group-focus-within:translate-y-0 group-focus-within:opacity-100"
    : "translate-y-2 opacity-0 transition duration-300 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100";
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

  return (
    <motion.div
      className={`h-full min-w-0 shrink-0 ${sizeClass}`}
      whileTap={shouldReduceMotion ? undefined : { scale: 0.985 }}
      {...motionProps}
    >
      <div
        className={`media-card-cinematic group relative flex h-full w-full min-w-0 flex-col scroll-ml-4 transform-gpu overflow-hidden rounded-xl border bg-[var(--surface)] shadow-cinematic-card transition-[background-color,border-color,box-shadow,transform] duration-300 will-change-transform hover:z-10 hover:-translate-y-1.5 hover:scale-[1.025] hover:border-white/20 hover:bg-[var(--surface-hover)] hover:shadow-cinematic-card-hover motion-reduce:hover:translate-y-0 motion-reduce:hover:scale-100 ${
          isWatched
            ? "border-emerald-300/70 ring-2 ring-emerald-300/45 shadow-[0_0_0_1px_rgba(52,211,153,0.28),0_22px_60px_rgba(16,185,129,0.2)]"
            : "border-white/10"
        }`}
      >
        <Link
          to={primaryCardTo}
          aria-label={primaryCardLabel}
          className="absolute inset-0 z-30 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
        <div
          className={`artwork-edge-vignette pointer-events-none relative z-40 shrink-0 overflow-hidden bg-zinc-900 ${isLandscape ? "aspect-video" : "aspect-[2/3]"}`}
        >
          {!imageLoaded && displayImageUrl && !imageFailed ? (
            <div className="shimmer absolute inset-0" />
          ) : null}
          {displayImageUrl && !imageFailed ? (
            <img
              src={displayImageUrl}
              alt={title}
              loading="lazy"
              className={`h-full w-full ${artworkObjectFitClass} transition-[transform,filter,opacity] duration-500 group-hover:scale-[1.04] group-focus-within:scale-[1.08] ${
                imageLoaded ? "opacity-100" : "opacity-0"
              }`}
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
          <div className="absolute inset-0 transition group-hover:opacity-100" />
          {canPlay && onClearContinueWatching ? (
            <ClearWatchingButton
              item={item}
              onCleared={onClearContinueWatching}
              className="pointer-events-auto absolute right-3 top-3 z-50 flex h-9 w-9 shrink-0 -translate-y-1 items-center justify-center rounded-full border border-white/15 bg-gray-600/90 text-white opacity-0 shadow-player-controls transition duration-300 hover:bg-gray-500 focus:translate-y-0 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
            />
          ) : null}
          {canPlay && onWatchedStatusReset ? (
            <WatchedStatusButton
              scope="item"
              action={isWatched ? "remove" : "mark"}
              item={item}
              onReset={onWatchedStatusReset}
              className={`pointer-events-auto absolute z-50 flex h-10 w-10 shrink-0 translate-y-1 items-center justify-center rounded-full border border-white/15 bg-gray-600/90 text-white opacity-0 shadow-player-controls transition duration-500 hover:bg-gray-500 focus:translate-y-0 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:-translate-y-3 group-hover:opacity-100 group-focus-within:-translate-y-3 group-focus-within:opacity-100 ${
                onClearContinueWatching ? "right-3 top-5" : "left-3 top-5"
              }`}
            />
          ) : null}
          {canPlay && showRestartWatching ? (
            <RestartWatchingButton
              item={item}
              className="pointer-events-auto absolute left-3 bottom-3 z-50 flex h-10 w-10 shrink-0 translate-y-1 items-center justify-center rounded-full border border-white/15 bg-gray-600/90 text-white opacity-0 shadow-player-controls transition duration-500 hover:bg-gray-500 focus:translate-y-0 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:-translate-y-3 group-hover:opacity-100 group-focus-within:-translate-y-3 group-focus-within:opacity-100"
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
                className="pointer-events-auto absolute left-3 bottom-3 z-50 flex h-10 w-10 shrink-0 translate-y-1 items-center justify-center rounded-full border border-white/15 bg-gray-600/90 text-white opacity-0 shadow-player-controls transition duration-500 hover:bg-gray-500 focus:translate-y-0 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:-translate-y-3 group-hover:opacity-100 group-focus-within:-translate-y-3 group-focus-within:opacity-100"
              >
                <RotateCcw size={16} />
              </Link>
            </Tooltip>
          ) : null}
          <Tooltip content={t("common.details")}>
            <Link
              to={to}
              aria-label={detailsLabel}
              className="pointer-events-auto absolute right-3 bottom-3 z-50 flex h-10 w-10 shrink-0 translate-y-1 items-center justify-center rounded-full border border-white/15 bg-gray-600/90 shadow-3xl text-white opacity-0 shadow-player-controls transition duration-500 hover:bg-gray-500 focus:translate-y-0 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:-translate-y-3 group-hover:opacity-100 group-focus-within:-translate-y-3 group-focus-within:opacity-100"
            >
              <Info size={16} />
            </Link>
          </Tooltip>
        </div>

        <div
          className={`panel-top-highlight pointer-events-none relative z-40 flex flex-1 flex-col bg-[#171717]/95 p-2.5 shadow-soft-inset sm:p-3.5 ${panelClass}`}
        >
          {progressPercent !== null ? (
            <div className="absolute inset-x-0 top-0 h-1.5 bg-white/[0.18]">
              <div
                data-testid="media-card-progress-fill"
                className="h-full bg-[var(--accent)]"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          ) : null}
          <WatchedIndicator
            item={item}
            className="mb-2 self-end px-2 py-0.5 text-[0.56rem] tracking-[0.14em] sm:px-2.5 sm:py-1 sm:text-[0.62rem]"
            iconSize={12}
          />
          <div className="flex flex-1 items-center">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={displayTitle}
                className="mx-auto h-auto max-h-16 w-auto object-contain object-left sm:max-h-28"
              />
            ) : (
              <h3
                className={`h-8 w-full truncate font-bold leading-8 text-white sm:h-10 sm:leading-10 ${
                  isSeasonEpisodeGrid
                    ? "text-base sm:text-3xl"
                    : "text-xs sm:text-sm"
                }`}
              >
                {displayTitle}
              </h3>
            )}
          </div>

          <div className="mt-auto pt-3">
            {countLabel && item.Type !== "Episode" ? (
              <p className="h-5 truncate text-xs font-bold leading-5 text-white sm:text-sm">
                {countLabel}
              </p>
            ) : (
              <h3
                className={`h-5 truncate text-xs font-bold leading-5 sm:text-sm ${
                  secondaryLabel ? "text-white" : "text-transparent"
                }`}
                aria-hidden={!secondaryLabel}
              >
                {secondaryLabel ?? ""}
              </h3>
            )}

            {subtitle ? (
              <p className="mt-0.5 h-4 truncate text-[0.68rem] font-medium leading-4 text-white/50 sm:mt-1 sm:text-xs">
                {subtitle}
              </p>
            ) : (
              <p
                className={
                  isSeasonEpisodeGrid
                    ? "hidden"
                    : "mt-1 h-4 text-xs leading-4 text-transparent"
                }
                aria-hidden={true}
              />
            )}
            <div className="mt-2 flex translate-y-2 items-end gap-1.5 text-[0.68rem] font-semibold text-white/75 opacity-0 transition duration-300 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
              <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {item.ProductionYear ? (
                  <span className="rounded-full bg-white/10 px-2 py-0.5">
                    {item.ProductionYear}
                  </span>
                ) : null}

                {item.OfficialRating ? (
                  <span className="rounded-full bg-white/10 px-2 py-0.5">
                    {item.OfficialRating}
                  </span>
                ) : null}

                {item.RunTimeTicks ? (
                  <span className="rounded-full bg-white/10 px-2 py-0.5">
                    {Math.round(item.RunTimeTicks / 600000000)} dk
                  </span>
                ) : null}

                {item.Genres?.slice(0, 2).map((genre) => (
                  <span
                    key={genre}
                    className="rounded-full bg-white/10 px-2 py-0.5"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
