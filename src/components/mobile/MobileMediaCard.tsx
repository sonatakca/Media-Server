import { motion } from "framer-motion";
import { Info, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { getEpisodeDisplayMetadata } from "../../lib/episodeMetadataPreferences";
import { formatRuntime, getDisplayTitle } from "../../lib/format";
import { getLogoImageUrl, getPrimaryImageUrl } from "../../lib/jellyfinApi";
import type { JellyfinItem } from "../../lib/types";
import { getItemProgressPercent, isItemCompleted } from "../../lib/watchStatus";
import { ClearWatchingButton } from "../ClearWatchingButton";
import { CollectionPosterMosaic } from "../CollectionPosterMosaic";
import { RestartWatchingButton } from "../RestartWatchingButton";
import { WatchedIndicator } from "../WatchedIndicator";
import { WatchedStatusButton } from "../WatchedStatusButton";
import { Tooltip } from "../ui/Tooltip";

interface MobileMediaCardProps {
  item: JellyfinItem;
  to: string;
  variant?: "poster" | "landscape";
  layout?: "row" | "grid";
  showRestartWatching?: boolean;
  collectionItems?: JellyfinItem[];
  animateRemoval?: boolean;
  onClearContinueWatching?: (item: JellyfinItem) => void;
  onWatchedStatusReset?: (items: JellyfinItem[]) => void;
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

function getSeriesCount(
  item: JellyfinItem,
  t: (key: TranslationKey) => string,
): string | null {
  const seasonCount = item.ChildCount;
  const episodeCount = item.RecursiveItemCount;

  if (item.Type === "Series") {
    if (seasonCount && episodeCount) {
      return `${countLabel(seasonCount, "media.seasonSingular", "media.seasonPlural", t)} · ${countLabel(episodeCount, "media.episodeSingular", "media.episodePlural", t)}`;
    }
    if (seasonCount) {
      return countLabel(
        seasonCount,
        "media.seasonSingular",
        "media.seasonPlural",
        t,
      );
    }
  }

  if (item.Type === "Season") {
    const count = item.ChildCount ?? item.RecursiveItemCount;
    if (count) {
      return countLabel(
        count,
        "media.episodeSingular",
        "media.episodePlural",
        t,
      );
    }
  }

  return null;
}

export function MobileMediaCard({
  item,
  to,
  variant = "poster",
  layout = "row",
  showRestartWatching = false,
  collectionItems,
  animateRemoval = false,
  onClearContinueWatching,
  onWatchedStatusReset,
}: MobileMediaCardProps) {
  const { language, t } = useLanguage();
  const labels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };

  const isEpisode = item.Type === "Episode";
  const episodeMetadata = isEpisode
    ? getEpisodeDisplayMetadata(item, language)
    : null;
  const isSeason = item.Type === "Season";
  const isLandscape = variant === "landscape";
  const isRow = layout === "row";
  const isWatched = isItemCompleted(item);

  const baseTitle = getDisplayTitle(item, labels);

  // === Desktop Matching Logic for Titles ===
  let mainTitle = baseTitle;
  let secondaryTitle: string | null = null;
  let tertiaryInfo: string | null = null;

  const runtime = formatRuntime(item.RunTimeTicks, labels);
  const countText = getSeriesCount(item, t);
  const progressPercent = getItemProgressPercent(item);

  if (isEpisode) {
    // Top line is the big bold episode number (e.g. "3. Bölüm")
    mainTitle =
      item.IndexNumber != null
        ? formatTemplate(t("media.episodeNumber"), { number: item.IndexNumber })
        : baseTitle;

    // Second line is the specific name of that episode
    secondaryTitle = episodeMetadata?.title ?? item.Name;

    // Third line is the year and runtime (like desktop!)
    tertiaryInfo = [item.ProductionYear, runtime].filter(Boolean).join("  ");
  } else if (isSeason) {
    // For seasons, just show "1. Sezon" or similar
    mainTitle = baseTitle;
    secondaryTitle = item.SeriesName || null;
    tertiaryInfo = countText;
  } else {
    // Standard movies or series
    mainTitle = baseTitle;
    tertiaryInfo =
      countText ?? [item.ProductionYear, runtime].filter(Boolean).join(" / ");
  }

  const shouldPlayOnCardClick =
    item.Type === "Episode" || item.MediaType === "Video";
  const primaryTo = shouldPlayOnCardClick ? `/watch/${item.Id}` : to;

  // Use Series Poster if it's an episode being shown as a vertical poster
  const imageUrl =
    isEpisode && isLandscape && episodeMetadata?.thumbnailUrl
      ? episodeMetadata.thumbnailUrl
      : isEpisode && !isLandscape && item.SeriesId && item.SeriesPrimaryImageTag
        ? getPrimaryImageUrl(item.SeriesId, item.SeriesPrimaryImageTag, 440)
        : item.ImageTags?.Primary
          ? getPrimaryImageUrl(
              item.Id,
              item.ImageTags.Primary,
              isLandscape ? 680 : 440,
            )
          : "";

  const logoUrl =
    !isEpisode && !isSeason && item.ImageTags?.Logo
      ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 420)
      : !isEpisode &&
          !isSeason &&
          item.ParentLogoItemId &&
          item.ParentLogoImageTag
        ? getLogoImageUrl(item.ParentLogoItemId, item.ParentLogoImageTag, 420)
        : "";

  return (
    <motion.article
      layout={animateRemoval ? "position" : undefined}
      exit={
        animateRemoval
          ? { opacity: 0, x: -28, scale: 0.96, filter: "blur(6px)" }
          : undefined
      }
      className={
        isRow
          ? variant === "landscape"
            ? "flex w-72 shrink-0 snap-start flex-col sm:w-80"
            : "flex w-44 shrink-0 snap-start flex-col sm:w-52"
          : "flex min-w-0 h-full flex-col"
      }
    >
      <div
        className={`flex flex-1 flex-col overflow-hidden rounded-xl border bg-[#141416] shadow-cinematic-card ${
          isWatched
            ? "border-emerald-300/70 ring-2 ring-emerald-300/45 shadow-[0_0_0_1px_rgba(52,211,153,0.25),0_18px_48px_rgba(16,185,129,0.18)]"
            : "border-white/10"
        }`}
      >
        <div
          className={`relative shrink-0 overflow-hidden bg-zinc-900 ${
            isLandscape ? "aspect-video" : "aspect-[2/3]"
          }`}
        >
          <Link
            to={primaryTo}
            aria-label={`${shouldPlayOnCardClick ? t("common.play") : t("common.details")} ${mainTitle}`}
            className="block h-full w-full focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent)]"
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={mainTitle}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : collectionItems?.length ? (
              <CollectionPosterMosaic
                title={mainTitle}
                items={collectionItems}
                imageSize={isLandscape ? 520 : 400}
              />
            ) : (
              <span className="flex h-full items-center justify-center bg-[linear-gradient(145deg,#27272a,#080809)] p-3 text-center text-xs font-bold text-white/80">
                {mainTitle}
              </span>
            )}
          </Link>

          {progressPercent !== null ? (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
              <div
                data-testid="media-card-progress-fill"
                className="h-full bg-[var(--accent)]"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col justify-center px-3.5 py-3">
          <WatchedIndicator
            item={item}
            className="mb-1.5 self-start px-2 py-0.5 text-[0.52rem] tracking-[0.12em]"
            iconSize={11}
          />

          {logoUrl ? (
            <img
              src={logoUrl}
              alt={mainTitle}
              loading="lazy"
              decoding="async"
              className="mb-1.5 max-h-7 max-w-full object-contain object-left"
            />
          ) : (
            <h3
              className={`truncate font-black text-white ${
                isEpisode ? "text-lg tracking-tight" : "text-xs"
              }`}
            >
              {mainTitle}
            </h3>
          )}

          {secondaryTitle ? (
            <p className="mt-1 truncate text-xs font-semibold text-white/90">
              {secondaryTitle}
            </p>
          ) : null}

          {tertiaryInfo ? (
            <div className="mt-1.5 flex items-center gap-2">
              {isEpisode ? (
                tertiaryInfo.split("  ").map((infoChunk, idx) => (
                  <span
                    key={idx}
                    className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[0.62rem] font-bold text-white/55"
                  >
                    {infoChunk}
                  </span>
                ))
              ) : (
                <p className="truncate text-[0.68rem] font-medium text-white/52">
                  {tertiaryInfo}
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </motion.article>
  );
}
