import type { MouseEvent, ReactNode } from "react";
import { AlignLeft, Info, Play, RotateCcw } from "lucide-react";
import { motion, type Variants } from "framer-motion";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import type { MediaItem } from "../../lib/types";
import { FavouriteButton } from "../FavouriteButton";
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

export interface HeroActionsProps {
  item: MediaItem;
  playTo: string;
  playLabel: string;
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
}

export function HeroActions({
  item,
  playTo,
  playLabel,
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
}: HeroActionsProps) {
  const { t } = useLanguage();
  const overviewLabel = isOverviewOpen
    ? t("hero.hideOverview")
    : t("hero.showOverview");

  return (
    <div className="flex flex-nowrap items-center gap-2.5">
      <motion.span variants={fade} className={`inline-flex ${PRESS}`}>
        <Link
          to={playTo}
          onClick={onPlay}
          className={`relative ${PILL} ${PLAY} ${FOCUS} pl-5 pr-6`}
        >
          <Play size={19} fill="currentColor" />
          <span>{playLabel}</span>
          {progress ? (
            <>
              <span className="font-semibold tabular-nums text-zinc-500">
                {t("hero.timeLeft").replace("{time}", progress.left)}
              </span>
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

      {startOverTo ? (
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
      <Surfaced fade={fade} surface={SMOKE}>
        {onShowDetails ? (
          <button
            type="button"
            onClick={onShowDetails}
            className={`${PILL} text-white ${FOCUS}`}
          >
            <Info size={19} strokeWidth={2.2} />
            {t("common.details")}
          </button>
        ) : (
          <Link
            to={detailsTo}
            state={SCROLL_TO_DETAILS_STATE}
            className={`${PILL} text-white ${FOCUS}`}
          >
            <Info size={19} strokeWidth={2.2} />
            {t("common.details")}
          </Link>
        )}
      </Surfaced>
      <Surfaced fade={fade} surface={SMOKE}>
        <FavouriteButton
          item={item}
          iconSize={20}
          className={`${ROUND} text-white ${FOCUS}`}
        />
      </Surfaced>
      {hasOverview ? (
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
