import { motion } from "framer-motion";
import { ChevronsRight, X } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { getEpisodeDisplayMetadata } from "../../lib/episodeMetadataPreferences";
import { formatTemplate } from "../../lib/format";
import { getPrimaryImageUrl } from "../../lib/jellyfinApi";
import type { JellyfinItem } from "../../lib/types";
import { Tooltip } from "../ui/Tooltip";

interface NextEpisodeCountdownOverlayProps {
  nextEpisode: JellyfinItem;
  secondsRemaining: number;
  shouldReduceMotion: boolean;
  onPlayNow: () => void;
  onCancel: () => void;
  onControlsHoverStart?: () => void;
  onControlsHoverEnd?: () => void;
}

export function NextEpisodeCountdownOverlay({
  nextEpisode,
  secondsRemaining,
  shouldReduceMotion,
  onPlayNow,
  onCancel,
  onControlsHoverStart,
  onControlsHoverEnd,
}: NextEpisodeCountdownOverlayProps) {
  const { language, t } = useLanguage();
  const nextEpisodeMetadata = getEpisodeDisplayMetadata(nextEpisode, language);
  const nextEpisodeImageUrl =
    nextEpisodeMetadata.thumbnailUrl ??
    (nextEpisode.ImageTags?.Primary
      ? getPrimaryImageUrl(nextEpisode.Id, nextEpisode.ImageTags.Primary, 320)
      : "");
  const nextEpisodeTitle = nextEpisodeMetadata.title ?? nextEpisode.Name;
  const nextEpisodeSeasonNumber =
    typeof nextEpisode.ParentIndexNumber === "number" &&
    Number.isFinite(nextEpisode.ParentIndexNumber)
      ? nextEpisode.ParentIndexNumber
      : null;
  const nextEpisodeNumber =
    typeof nextEpisode.IndexNumber === "number" &&
    Number.isFinite(nextEpisode.IndexNumber)
      ? nextEpisode.IndexNumber
      : null;
  const nextEpisodeContextParts =
    nextEpisodeSeasonNumber !== null && nextEpisodeNumber !== null
      ? [
          formatTemplate(t("media.seasonEpisodeNumber"), {
            seasonNumber: nextEpisodeSeasonNumber,
            episodeNumber: nextEpisodeNumber,
          }),
        ]
      : [
          nextEpisodeSeasonNumber !== null
            ? formatTemplate(t("media.seasonNumber"), {
                number: nextEpisodeSeasonNumber,
              })
            : nextEpisode.SeasonName,
          nextEpisodeNumber !== null
            ? formatTemplate(t("media.episodeNumber"), {
                number: nextEpisodeNumber,
              })
            : null,
        ].filter(Boolean);

  return (
    <motion.div
      className="pointer-events-auto absolute bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+5.9rem)] right-[max(0.85rem,env(safe-area-inset-right))] z-[39] flex w-[min(24rem,calc(100vw-1.7rem))] flex-col items-end gap-2 text-white sm:bottom-[calc(max(1.25rem,env(safe-area-inset-bottom))+7.5rem)] sm:right-[max(1.25rem,env(safe-area-inset-right))]"
      initial={
        shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }
      }
      animate={
        shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }
      }
      exit={
        shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }
      }
      transition={
        shouldReduceMotion
          ? { duration: 0.01 }
          : {
              duration: 0.22,
              ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
            }
      }
      onMouseEnter={onControlsHoverStart}
      onMouseLeave={onControlsHoverEnd}
      onPointerEnter={onControlsHoverStart}
      onPointerLeave={onControlsHoverEnd}
    >
      <div className="relative w-full overflow-hidden rounded-xl bg-zinc-950/90 shadow-player-controls">
        <Tooltip content={t("player.cancelNextEpisode")}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCancel();
            }}
            className="absolute right-2.5 top-2.5 z-20 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white/80 shadow-player-controls transition hover:bg-white/[0.14] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:right-3 sm:top-3"
            aria-label={t("player.cancelNextEpisode")}
          >
            <X className="h-3.5 w-3.5 sm:h-4 sm:w-4" strokeWidth={2.4} />
          </button>
        </Tooltip>

        <div className="relative h-28 w-full overflow-hidden bg-white/[0.06] sm:h-32">
          {nextEpisodeImageUrl ? (
            <img
              src={nextEpisodeImageUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              draggable={false}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[var(--accent)]/16 text-3xl font-black text-[var(--accent)]">
              {secondsRemaining}
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-zinc-950/70 via-zinc-950/18 to-transparent" />
          <div className="absolute bottom-3 left-3 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/45 text-lg font-black text-white shadow-lg">
            {secondsRemaining}
          </div>
        </div>

        <div className="px-3 pb-3 pt-3 sm:px-4 sm:pb-4">
          <p className="pr-10 text-xs font-black uppercase tracking-[0.16em] text-[var(--accent)]">
            {formatTemplate(t("player.nextEpisodeIn"), {
              seconds: secondsRemaining,
            })}
          </p>
          <p className="mt-1 line-clamp-2 pr-2 text-base font-black leading-6 text-white sm:text-lg">
            {nextEpisodeTitle}
          </p>
          {nextEpisode.SeriesName || nextEpisodeContextParts.length > 0 ? (
            <p className="mt-1 truncate text-xs font-semibold text-white/55">
              {[nextEpisode.SeriesName, ...nextEpisodeContextParts]
                .filter(Boolean)
                .join(" \u00b7 ")}
            </p>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onPlayNow();
        }}
        className="inline-flex min-h-9 items-center justify-center gap-2 rounded-full bg-white z-50 mt-2 px-4 text-xs font-black text-zinc-950 shadow-player-controls transition hover:bg-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black sm:min-h-10 sm:px-5 sm:text-sm"
      >
        <ChevronsRight className="h-4 w-4 shrink-0" strokeWidth={2.5} />
        <span>{t("player.playNow")}</span>
      </button>
    </motion.div>
  );
}
