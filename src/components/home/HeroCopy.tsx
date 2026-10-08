import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  motion,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatRuntime } from "../../lib/format";
import { getItemDisplayMetadata } from "../../lib/itemMetadataPreferences";
import {
  logoShadowFor,
  measureBackdropLuminance,
  type SampleRegion,
} from "../../lib/logoShadow";
import { getPlayTargetForItem } from "../../lib/playTarget";
import { getRouteForItem } from "../../lib/routes";
import type { MediaItem } from "../../lib/types";
import { getStageImageCandidates } from "../hero/heroModel";
import { Tooltip } from "../ui/Tooltip";
import { HeroActions, heroPlayState } from "./HeroActions";
import { sampleUrl } from "./logoShadowStyle";
import { copyShadowFor } from "./heroCopyShadow";
import {
  COPY_ROWS,
  HERO_MOTION,
  type HeroLayout,
  type StageSize,
} from "./homeHeroModel";

/**
 * The copy that sits under a hero's title, bottom-left: the facts, the
 * overview on request, and the ways in. Shared by the home hero and a
 * title's own page, so both read and behave alike.
 */

/**
 * How long the pointer rests on the title before its overview opens, so
 * passing over it on the way somewhere else opens nothing.
 */
const OVERVIEW_HOVER_INTENT_MS = 260;

/**
 * The title and its copy, as one hover target. The block reaches up over the
 * resting title, so resting the pointer on it opens the overview; once open
 * it also covers the risen, grown title.
 */
export function HeroCopyBlock({
  stage,
  layout,
  item,
  overview,
  isOverviewOpen,
  onHoverIntent,
  onFocusWithin,
  onToggleOverview,
  onShowDetails,
  reduceMotion,
  smartContinueItems,
}: {
  stage: StageSize;
  layout: HeroLayout;
  /** The title the copy describes; null while it is between titles. */
  item: MediaItem | null;
  overview: MotionValue<number>;
  isOverviewOpen: boolean;
  /** The pointer has rested on the title (true), or left it (false). */
  onHoverIntent: (open: boolean) => void;
  onFocusWithin: (focused: boolean) => void;
  onToggleOverview: () => void;
  /** Where "Details" goes when the title's details are further down this page. */
  onShowDetails?: () => void;
  reduceMotion: boolean;
  smartContinueItems: MediaItem[];
}) {
  const intentRef = useRef(0);
  const itemId = item?.Id;
  useEffect(() => () => window.clearTimeout(intentRef.current), [itemId]);

  return (
    <div
      className="absolute z-[6]"
      style={{
        left: layout.copy.left - 16,
        bottom: layout.copy.bottom,
        width: Math.max(layout.copy.width, layout.title.width) + 32,
        // The resting title and its copy; while open, the risen, full-size
        // title too, so the pointer can move onto it without closing it.
        height:
          layout.title.bottom -
          layout.copy.bottom +
          12 +
          (isOverviewOpen
            ? layout.title.height + layout.overviewLift
            : layout.title.height * layout.titleScale.rest),
        pointerEvents: item ? "auto" : "none",
      }}
      onMouseEnter={() => {
        window.clearTimeout(intentRef.current);
        intentRef.current = window.setTimeout(
          () => onHoverIntent(true),
          OVERVIEW_HOVER_INTENT_MS,
        );
      }}
      onMouseLeave={() => {
        window.clearTimeout(intentRef.current);
        onHoverIntent(false);
      }}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) onFocusWithin(true);
      }}
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          onFocusWithin(false);
      }}
    >
      <div
        className="absolute"
        style={{
          left: 16,
          bottom: 0,
          width: layout.copy.width,
          height: layout.copy.height,
        }}
      >
        <AnimatePresence mode="wait">
          {item ? (
            <HeroCopy
              key={item.Id}
              item={item}
              stage={stage}
              layout={layout}
              factsRegion={{
                left: layout.copy.left / stage.width,
                top:
                  1 - (layout.copy.bottom + layout.copy.height) / stage.height,
                width: Math.min(layout.factsWidth, 340) / stage.width,
                height: COPY_ROWS.factsPx / stage.height,
              }}
              overview={overview}
              isOverviewOpen={isOverviewOpen}
              onToggleOverview={onToggleOverview}
              onShowDetails={onShowDetails}
              reduceMotion={reduceMotion}
              smartContinueItems={smartContinueItems}
            />
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

export function HeroControlButton({
  label,
  onClick,
  disabled,
  touch = false,
  className = "",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** A phone's control: a full 44px touch target. */
  touch?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} placement="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className={`${touch ? "h-11 w-11" : "h-9 w-9"} ${className} flex items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.12] hover:text-white active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * Room around the overview's reveal for its text's shade: the sides and top
 * get the shade's full reach, the foot only as much as the gap above the
 * actions allows.
 *
 * The reveal still needs an edge there, because the overview rises from
 * under the facts and must not show below them over the actions, but the
 * edge is a fade, not a cut: the foot fades out over its whole height, so a
 * line rising through it fades in, and the last line's shadow at rest thins
 * out instead of stopping in a straight line. The text itself ends where the
 * fade begins, so it is never dimmed at rest.
 */
const OVERVIEW_SHADE_ROOM_PX = 40;
const OVERVIEW_SHADE_FOOT_PX = 12;
const OVERVIEW_REVEAL_MASK = `linear-gradient(to bottom, #000 calc(100% - ${OVERVIEW_SHADE_FOOT_PX}px), transparent 100%)`;

/**
 * How bright the copy under the title needs to be, 0–1, from the brightness
 * of the artwork behind its facts line: resting over a dark picture, full
 * over a white sky. It starts in the middle, so nothing flashes unreadable while
 * the artwork is measured.
 */
function useCopyShade(
  item: MediaItem,
  stage: StageSize,
  layout: HeroLayout,
  region: SampleRegion,
): number {
  const [shade, setShade] = useState(0.5);
  const url = getStageImageCandidates(item, layout.form, stage.width)[0]?.url;
  const { left, top, width, height } = region;
  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
    void measureBackdropLuminance(sampleUrl(url), {
      left,
      top,
      width,
      height,
    }).then((luminance) => {
      if (cancelled) return;
      setShade(luminance === null ? 0.5 : logoShadowFor(1, luminance).strength);
    });
    return () => {
      cancelled = true;
    };
  }, [url, left, top, width, height]);
  // On a tall stage the copy stands where the picture has sunk into the
  // room, so it needs little more than its resting shadow.
  return layout.form === "tall" ? Math.min(shade, 0.35) : shade;
}

/**
 * White copy set straight on the artwork, brighter the more the picture
 * behind it needs, always on a black cloud of its own shape. The cloud
 * follows the letters, so it shades the words and nothing around them.
 *
 * Over bright art the cloud is denser; over dark art lighter and wider. A
 * one-pixel black edge was tried and read as an outline, too heavy and too
 * sharp on a real screen. Which one comes from the brightness measured
 * behind the facts line (`useCopyShade`), and until that arrives the copy
 * stands on the dark-art one.
 *
 * It is a filter, not a text shadow, because a filter is drawn after the
 * text is truncated and clamped: a text shadow is clipped with the text, and
 * ends in a rectangle. The widest blur, 20px, fits the overview's room
 * (OVERVIEW_SHADE_ROOM_PX).
 */
function copyTextStyle(shade: number, restingAlpha: number): CSSProperties {
  const a = (value: number) => value.toFixed(3);
  return {
    color: `rgba(255,255,255,${a(restingAlpha + (0.97 - restingAlpha) * shade)})`,
    filter: copyShadowFor(shade),
  };
}

/** What to show under the title: facts, a few lines of story, and the ways in. */
function HeroCopy({
  item,
  stage,
  layout,
  factsRegion,
  overview,
  isOverviewOpen,
  onToggleOverview,
  onShowDetails,
  reduceMotion,
  smartContinueItems,
}: {
  item: MediaItem;
  stage: StageSize;
  layout: HeroLayout;
  /** Where the facts line lies over the artwork, as shares of it. */
  factsRegion: SampleRegion;
  /** 0–1: the overview opening under the facts. */
  overview: MotionValue<number>;
  isOverviewOpen: boolean;
  onToggleOverview: () => void;
  /** Where "Details" goes when the title's details are further down this page. */
  onShowDetails?: () => void;
  reduceMotion: boolean;
  smartContinueItems: MediaItem[];
}) {
  const { language, t } = useLanguage();
  const navigate = useNavigate();
  const shade = useCopyShade(item, stage, layout, factsRegion);
  const labels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };
  const metadata = getItemDisplayMetadata(item, language);
  const runtime = formatRuntime(item.RunTimeTicks, labels);
  const facts = [
    item.ProductionYear,
    runtime,
    item.Genres?.filter(Boolean).slice(0, 2).join(", "),
  ]
    .filter(Boolean)
    .join("  ·  ");

  const { playItem, playLabel, shortPlayLabel, canStartOver, progress } =
    heroPlayState(item, smartContinueItems, t);
  const playTo =
    playItem.Type === "Series"
      ? getRouteForItem(playItem)
      : `/watch/${playItem.Id}`;

  const overviewId = useId();
  const factsY = useTransform(
    overview,
    (value) => -value * layout.overviewLift,
  );
  // The overview comes up from under the facts as they rise off it.
  const overviewY = useTransform(
    overview,
    [0, 1],
    [layout.overviewHeight + OVERVIEW_SHADE_FOOT_PX, 0],
  );
  const overviewOpacity = useTransform(overview, [0, 0.45, 1], [0, 0.7, 1]);

  const handlePlay = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(await getPlayTargetForItem(playItem));
  };

  // The copy changes with the title by fading in place: only the title and
  // the artwork travel.
  const line = (index: number) => ({
    initial: { opacity: 0 },
    animate: {
      opacity: 1,
      transition: {
        duration: reduceMotion ? 0.2 : HERO_MOTION.copyEnterS,
        delay: reduceMotion ? 0 : index * HERO_MOTION.copyEnterStaggerS,
        ease: "easeOut" as const,
      },
    },
    exit: {
      opacity: 0,
      transition: {
        duration: reduceMotion ? 0.15 : HERO_MOTION.copyExitS,
        delay: reduceMotion ? 0 : index * HERO_MOTION.copyExitStaggerS,
        ease: "easeIn" as const,
      },
    },
  });

  return (
    <motion.div
      className="relative h-full"
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {/* Fixed rows: the title above sits at the same height for every
          title. The facts ride up with the title as the overview opens. */}
      <motion.div
        className="absolute inset-x-0 top-0"
        style={{ height: COPY_ROWS.factsPx, y: factsY }}
      >
        <motion.p
          variants={line(0)}
          className="truncate text-[0.8125rem] font-bold leading-5 tracking-[0.04em]"
          style={{ ...copyTextStyle(shade, 0.72), maxWidth: layout.factsWidth }}
        >
          {facts}
        </motion.p>
      </motion.div>
      {metadata.overview ? (
        <div
          id={overviewId}
          className="pointer-events-none absolute overflow-hidden"
          style={{
            // The reveal's clip, widened by the room the text's shade needs,
            // and soft along the foot (see OVERVIEW_SHADE_FOOT_PX).
            WebkitMaskImage: OVERVIEW_REVEAL_MASK,
            maskImage: OVERVIEW_REVEAL_MASK,
            left: -OVERVIEW_SHADE_ROOM_PX,
            right: -OVERVIEW_SHADE_ROOM_PX,
            bottom:
              COPY_ROWS.actionsPx + layout.actionsGap - OVERVIEW_SHADE_FOOT_PX,
            height:
              layout.overviewHeight +
              OVERVIEW_SHADE_ROOM_PX +
              OVERVIEW_SHADE_FOOT_PX,
            padding: `${OVERVIEW_SHADE_ROOM_PX}px ${OVERVIEW_SHADE_ROOM_PX}px ${OVERVIEW_SHADE_FOOT_PX}px`,
          }}
        >
          <motion.p
            className="line-clamp-3 max-w-[46ch] font-semibold"
            style={{
              ...copyTextStyle(shade, 0.8),
              fontSize: layout.overviewFontPx,
              lineHeight: COPY_ROWS.overviewLineHeight,
              y: overviewY,
              opacity: overviewOpacity,
            }}
          >
            {metadata.overview}
          </motion.p>
        </div>
      ) : null}
      {/* Not faded here: each action fades its own surface (see HeroActions). */}
      <div
        className="absolute inset-x-0 bottom-0"
        style={{ height: COPY_ROWS.actionsPx }}
      >
        <HeroActions
          item={item}
          playTo={playTo}
          playLabel={playLabel}
          shortPlayLabel={shortPlayLabel}
          onPlay={handlePlay}
          startOverTo={
            canStartOver
              ? `${playTo}${playTo.includes("?") ? "&" : "?"}start=0`
              : null
          }
          detailsTo={getRouteForItem(item)}
          progress={progress}
          overviewId={overviewId}
          hasOverview={Boolean(metadata.overview)}
          isOverviewOpen={isOverviewOpen}
          onToggleOverview={onToggleOverview}
          onShowDetails={onShowDetails}
          compact={layout.actions === "compact"}
          fade={line(1)}
        />
      </div>
    </motion.div>
  );
}
