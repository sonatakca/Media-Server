import type { MouseEvent, ReactNode } from "react";
import { AlignLeft, Info, Play, RotateCcw } from "lucide-react";
import { motion, type Variants } from "framer-motion";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { formatRuntime } from "../../lib/format";
import type { MediaItem } from "../../lib/types";
import { canStartOverFromHero } from "../HeroSection";
import { FavouriteButton } from "../FavouriteButton";
import { DownloadButton } from "../offline/DownloadButton";
import { isOfflineSupported } from "../../lib/offline/offlineLibrary";
import { Tooltip } from "../ui/Tooltip";

/**
 * The hero's ways in: play, start over, details, My List, the overview.
 * They sit straight on the artwork, whose brightness nothing controls, so
 * every surface here is opaque enough to hold its contrast over a white
 * sky as well as a night scene, and every shadow has room to fall.
 *
 * They fade with the title, and the fade is on each surface, never on a
 * box around them: while anything around a blurred surface is translucent
 * the browser has nothing behind it to blur, so a faded container shows
 * flat glass for the whole fade and snaps the blur on at the end.
 */

const FOCUS =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050607]";
const PRESS =
  "transition-transform duration-200 ease-out active:scale-[0.97] motion-reduce:active:scale-100";

/** Smoked glass: dark enough to read on any artwork, still of the room. */
const SMOKE =
  "border border-white/[0.13] bg-[rgba(10,11,13,0.66)] backdrop-blur-2xl backdrop-saturate-[1.4] shadow-[inset_0_1px_0_rgba(255,255,255,0.09),0_12px_32px_-10px_rgba(0,0,0,0.7),0_2px_8px_rgba(0,0,0,0.28)] transition-[background-color,border-color] duration-200 ease-out group-hover:border-white/[0.22] group-hover:bg-[rgba(24,26,29,0.8)]";
/** The overview button while the overview is open. */
const LIT = "bg-white transition-colors duration-200 group-hover:bg-zinc-100";
/**
 * The one bright thing: solid white, lifted by a soft falling shadow, with a
 * hairline that keeps its edge against a white sky.
 */
const PLAY =
  "bg-white text-zinc-950 shadow-[0_0_0_1px_rgba(0,0,0,0.07),inset_0_-1px_0_rgba(0,0,0,0.08),0_14px_32px_-10px_rgba(0,0,0,0.65),0_2px_8px_rgba(0,0,0,0.25)] transition-colors duration-200 hover:bg-zinc-100";

/**
 * "Details" from the home hero opens the title's page already on its way
 * down to the details: that page opens on this same hero, and showing it
 * twice in a row would read as nothing having happened.
 */
const SCROLL_TO_DETAILS_STATE = { scrollToDetails: true } as const;

const ROUND =
  "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full";
const PILL =
  "inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full px-6 text-[0.9375rem] font-bold";

/**
 * A control on the artwork: its surface is a layer of its own, faded with
 * its content, so no parent of the blur is ever translucent.
 */
function Surfaced({
  fade,
  surface,
  children,
}: {
  fade: Variants;
  surface: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`group relative inline-flex shrink-0 rounded-full ${PRESS}`}
    >
      <motion.span
        aria-hidden="true"
        variants={fade}
        className={`pointer-events-none absolute inset-0 rounded-full ${surface}`}
      />
      <motion.span variants={fade} className="relative inline-flex">
        {children}
      </motion.span>
    </span>
  );
}

/**
 * What play says and where it starts: the title itself, or for a title under
 * way the place it was left, with how far in and how long is left.
 */
export function heroPlayState(
  item: MediaItem,
  smartContinueItems: MediaItem[],
  t: (key: TranslationKey) => string,
) {
  const labels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };
  const continueTarget = smartContinueItems.find((candidate) =>
    item.Type === "Series"
      ? candidate.Type === "Episode" && candidate.SeriesId === item.Id
      : candidate.Id === item.Id,
  );
  const playItem = continueTarget ?? item;
  const hasProgress =
    (continueTarget?.UserData?.PlaybackPositionTicks ?? 0) > 0;
  const episodeLabel =
    continueTarget?.Type === "Episode" &&
    typeof continueTarget.ParentIndexNumber === "number" &&
    typeof continueTarget.IndexNumber === "number"
      ? t("media.seasonEpisodeNumber")
          .replace("{seasonNumber}", String(continueTarget.ParentIndexNumber))
          .replace("{episodeNumber}", String(continueTarget.IndexNumber))
      : null;
  const playVerb = hasProgress
    ? t("details.continueWatching")
    : t("common.play");
  const position = continueTarget?.UserData?.PlaybackPositionTicks ?? 0;
  const length = continueTarget?.RunTimeTicks ?? 0;
  const left =
    hasProgress && length > position
      ? formatRuntime(length - position, labels)
      : null;
  return {
    playItem,
    playLabel: `${playVerb}${episodeLabel ? `: ${episodeLabel}` : ""}`,
    // A phone's play button says only what it needs to: the episode it
    // starts, or the verb. The play glyph beside it already says "play".
    shortPlayLabel: episodeLabel ?? playVerb,
    canStartOver: canStartOverFromHero(playItem),
    progress: left ? { share: position / length, left } : null,
  };
}

/**
 * Which controls a row holds beside play. The row and its skeleton both read
 * this, so a placeholder is reserved for exactly what will load.
 */
export function heroRowParts({
  compact,
  onTitlePage,
  isFilm,
  canStartOver,
  hasOverview,
}: {
  compact: boolean;
  onTitlePage: boolean;
  isFilm: boolean;
  canStartOver: boolean;
  hasOverview: boolean;
}) {
  return {
    // A phone's home row already holds details, My List and the overview;
    // starting over waits on the title's page, so play keeps room for its
    // label and the row never holds more than three rounds.
    startOver: canStartOver && !(compact && !onTitlePage),
    // On a phone's title page its details, overview included, are the very
    // next thing down the page, and the row has no room to spare for ways
    // to them: "Details" and the overview button stay home.
    details: compact ? (onTitlePage ? null : "round") : "pill",
    // On a film's own page only: the home hero is for choosing, and a
    // series is downloaded an episode at a time.
    download: onTitlePage && isFilm && isOfflineSupported(),
    overview: hasOverview && !(compact && onTitlePage),
  } as const;
}

/** The round buttons a row holds: the parts that are round, and My List. */
export function heroRoundCount(parts: ReturnType<typeof heroRowParts>) {
  return (
    Number(parts.startOver) +
    Number(parts.details === "round") +
    1 +
    Number(parts.download) +
    Number(parts.overview)
  );
}

/** Play's shape on a full row; the skeleton draws its placeholder from it. */
export const PLAY_PILL = `${PILL} pl-5 pr-6`;
/** "Details" on a full row. */
export const DETAILS_PILL = PILL;
/** What a full row's play shows, in the order it shows it. */
export const PLAY_TIME_LEFT = "font-semibold tabular-nums";

export interface HeroActionsProps {
  item: MediaItem;
  playTo: string;
  playLabel: string;
  /** What a compact row's play button shows; its name stays `playLabel`. */
  shortPlayLabel?: string;
  onPlay: (event: MouseEvent<HTMLAnchorElement>) => void;
  startOverTo: string | null;
  detailsTo: string;
  /** How far into the title the viewer is, 0–1, and how long is left. */
  progress: { share: number; left: string } | null;
  overviewId: string;
  hasOverview: boolean;
  isOverviewOpen: boolean;
  onToggleOverview: () => void;
  /**
   * On the title's own page its details are further down, so "Details"
   * scrolls there instead of opening the page it is already on.
   */
  onShowDetails?: () => void;
  /** The copy's fade, driven by the copy it sits under. */
  fade: Variants;
  /**
   * A phone's row: play takes whatever width the round buttons leave,
   * "Details" becomes a round button like the rest, and the time left gives
   * way to the progress line under the label, which carries the same news.
   */
  compact?: boolean;
}

export function HeroActions({
  item,
  playTo,
  playLabel,
  shortPlayLabel = playLabel,
  onPlay,
  startOverTo,
  detailsTo,
  progress,
  overviewId,
  hasOverview,
  isOverviewOpen,
  onToggleOverview,
  onShowDetails,
  fade,
  compact = false,
}: HeroActionsProps) {
  const { t } = useLanguage();
  const parts = heroRowParts({
    compact,
    onTitlePage: Boolean(onShowDetails),
    isFilm: item.Type === "Movie",
    canStartOver: Boolean(startOverTo),
    hasOverview,
  });
  const overviewLabel = isOverviewOpen
    ? t("hero.hideOverview")
    : t("hero.showOverview");

  return (
    <div
      className={`flex flex-nowrap items-center ${compact ? "gap-1.5" : "gap-2.5"}`}
    >
      <motion.span
        variants={fade}
        className={`inline-flex ${compact ? "min-w-0 flex-1" : "shrink-0"} ${PRESS}`}
      >
        <Link
          to={playTo}
          onClick={onPlay}
          aria-label={compact ? playLabel : undefined}
          className={`relative ${PLAY} ${FOCUS} ${
            compact ? `${PILL} w-full min-w-0 shrink px-4` : PLAY_PILL
          }`}
        >
          <Play size={19} fill="currentColor" className="shrink-0" />
          {compact ? (
            <span className="truncate">{shortPlayLabel}</span>
          ) : (
            <span>{playLabel}</span>
          )}
          {progress ? (
            <>
              {compact ? null : (
                <span className={`${PLAY_TIME_LEFT} text-zinc-500`}>
                  {t("hero.timeLeft").replace("{time}", progress.left)}
                </span>
              )}
              {/* How far in, drawn under the label rather than as a halo. */}
              <span
                aria-hidden="true"
                className="absolute inset-x-6 bottom-[7px] h-[2px] overflow-hidden rounded-full bg-zinc-950/[0.12]"
              >
                <span
                  className="block h-full rounded-full bg-zinc-950"
                  style={{ width: `${Math.max(3, progress.share * 100)}%` }}
                />
              </span>
            </>
          ) : null}
        </Link>
      </motion.span>

      {parts.startOver && startOverTo ? (
        <Surfaced fade={fade} surface={SMOKE}>
          <Tooltip content={t("details.playFromBeginning")} placement="top">
            <Link
              to={startOverTo}
              aria-label={t("details.playFromBeginning")}
              className={`${ROUND} text-white ${FOCUS}`}
            >
              <RotateCcw size={18} strokeWidth={2.2} />
            </Link>
          </Tooltip>
        </Surfaced>
      ) : null}
      {parts.details === null ? null : (
        <Surfaced fade={fade} surface={SMOKE}>
          {onShowDetails ? (
            <button
              type="button"
              onClick={onShowDetails}
              aria-label={compact ? t("common.details") : undefined}
              className={`${compact ? ROUND : PILL} text-white ${FOCUS}`}
            >
              <Info size={19} strokeWidth={2.2} />
              {compact ? null : t("common.details")}
            </button>
          ) : (
            <Link
              to={detailsTo}
              state={SCROLL_TO_DETAILS_STATE}
              aria-label={compact ? t("common.details") : undefined}
              className={`${compact ? ROUND : PILL} text-white ${FOCUS}`}
            >
              <Info size={19} strokeWidth={2.2} />
              {compact ? null : t("common.details")}
            </Link>
          )}
        </Surfaced>
      )}
      <Surfaced fade={fade} surface={SMOKE}>
        <FavouriteButton
          item={item}
          iconSize={20}
          className={`${ROUND} text-white ${FOCUS}`}
        />
      </Surfaced>
      {parts.download ? (
        <Surfaced fade={fade} surface={SMOKE}>
          <DownloadButton
            item={item}
            className={`${ROUND} text-white ${FOCUS}`}
          />
        </Surfaced>
      ) : null}
      {parts.overview ? (
        <Surfaced fade={fade} surface={isOverviewOpen ? LIT : SMOKE}>
          <Tooltip content={overviewLabel} placement="top">
            <button
              type="button"
              aria-label={overviewLabel}
              aria-expanded={isOverviewOpen}
              aria-controls={overviewId}
              onClick={onToggleOverview}
              className={`${ROUND} ${FOCUS} transition-colors duration-200 ${
                isOverviewOpen ? "text-zinc-950" : "text-white"
              }`}
            >
              <AlignLeft size={19} strokeWidth={2.2} />
            </button>
          </Tooltip>
        </Surfaced>
      ) : null}
    </div>
  );
}
