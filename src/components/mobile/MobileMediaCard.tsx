import { motion } from "framer-motion";
import { Info, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
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

  if (item.Type !== "Series") {
    return null;
  }

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
  const { t } = useLanguage();
  const labels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };
  const title = getDisplayTitle(item, labels);
  const runtime = formatRuntime(item.RunTimeTicks, labels);
  const progressPercent = getItemProgressPercent(item);
  const countText = getSeriesCount(item, t);
  const subtitle =
    countText ?? [item.ProductionYear, runtime].filter(Boolean).join(" / ");
  const canPlay =
    item.Type === "Movie" ||
    item.Type === "Episode" ||
    item.MediaType === "Video";
  const primaryTo = canPlay ? `/watch/${item.Id}` : to;
  const isLandscape = variant === "landscape";
  const isRow = layout === "row";
  const isWatched = isItemCompleted(item);
  const imageUrl = item.ImageTags?.Primary
    ? getPrimaryImageUrl(
        item.Id,
        item.ImageTags.Primary,
        isLandscape ? 680 : 440,
      )
    : "";
  const logoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 420)
    : item.ParentLogoItemId && item.ParentLogoImageTag
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
      className={isRow ? "w-[8.8rem] shrink-0 snap-start" : "min-w-0"}
    >
      <div
        className={`overflow-hidden rounded-xl border bg-[#141416] shadow-cinematic-card ${
          isWatched
            ? "border-emerald-300/70 ring-2 ring-emerald-300/45 shadow-[0_0_0_1px_rgba(52,211,153,0.25),0_18px_48px_rgba(16,185,129,0.18)]"
            : "border-white/10"
        }`}
      >
        <div
          className={`relative overflow-hidden bg-zinc-900 ${
            isLandscape ? "aspect-video" : "aspect-[2/3]"
          }`}
        >
          <Link
            to={primaryTo}
            aria-label={`${canPlay ? t("common.play") : t("common.details")} ${title}`}
            className="block h-full w-full focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent)]"
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={title}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : collectionItems?.length ? (
              <CollectionPosterMosaic
                title={title}
                items={collectionItems}
                imageSize={isLandscape ? 520 : 400}
              />
            ) : (
              <span className="flex h-full items-center justify-center bg-[linear-gradient(145deg,#27272a,#080809)] p-3 text-center text-xs font-bold text-white/80">
                {title}
              </span>
            )}
            {canPlay ? (
              <span className="absolute bottom-2 left-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white text-black shadow-lg">
                <Play size={14} fill="currentColor" />
              </span>
            ) : null}
          </Link>

          {canPlay ? (
            <>
              {onClearContinueWatching ? (
                <ClearWatchingButton
                  item={item}
                  onCleared={onClearContinueWatching}
                  className="absolute left-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white backdrop-blur"
                  iconSize={15}
                />
              ) : null}
              {onWatchedStatusReset ? (
                <WatchedStatusButton
                  scope="item"
                  action={isWatched ? "remove" : "mark"}
                  item={item}
                  onReset={onWatchedStatusReset}
                  className={`absolute top-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white backdrop-blur ${
                    onClearContinueWatching ? "left-12" : "left-2"
                  }`}
                  iconSize={15}
                />
              ) : null}
              {showRestartWatching ? (
                <RestartWatchingButton
                  item={item}
                  className="absolute right-12 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white backdrop-blur"
                  iconSize={15}
                />
              ) : null}
              <Tooltip content={t("common.details")}>
                <Link
                  to={to}
                  aria-label={`${t("common.details")} ${title}`}
                  className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white backdrop-blur"
                >
                  <Info size={15} />
                </Link>
              </Tooltip>
            </>
          ) : null}

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

        <div className="flex min-h-[3.65rem] flex-col justify-center px-2.5 py-2.5">
          <WatchedIndicator
            item={item}
            className="mb-1.5 self-start px-2 py-0.5 text-[0.52rem] tracking-[0.12em]"
            iconSize={11}
          />
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={title}
              loading="lazy"
              decoding="async"
              className="mb-1.5 max-h-7 max-w-full object-contain object-left"
            />
          ) : (
            <h3 className="truncate text-xs font-bold text-white">{title}</h3>
          )}
          {subtitle ? (
            <p className="truncate text-[0.68rem] font-medium text-white/52">
              {subtitle}
            </p>
          ) : null}
        </div>
      </div>
    </motion.article>
  );
}
