import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { Info, Play } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { getItemDisplayMetadata } from "../../lib/itemMetadataPreferences";
import type { MediaItem } from "../../lib/types";
import {
  DETAILS_PILL,
  PLAY_PILL,
  PLAY_TIME_LEFT,
  heroPlayState,
  heroRoundCount,
  heroRowParts,
} from "./HeroActions";
import {
  COPY_ROWS,
  HERO_HEIGHT_CLASS,
  heroLayout,
  queueSlots,
  type HeroFit,
  type StageSize,
} from "./homeHeroModel";

/**
 * The home hero's loading state, placed from the same geometry as the hero
 * itself — every placeholder is the size of, and exactly where, the thing
 * that replaces it — so the hand-over from loading to content moves nothing.
 */

/** Sizes of the hero's own controls, as it renders them. */
const ACTIONS = {
  roundPx: 48,
  gapPx: 10,
  /** A compact row sits a little closer, to leave play its label. */
  compactGapPx: 6,
} as const;
const CONTROLS = {
  widthPx: 197,
  /** A phone's pill: pause and the position alone, at touch size. */
  compactWidthPx: 121,
  heightPx: 46,
  /** A phone's pill holds 44px buttons, so it stands taller. */
  compactHeightPx: 54,
  abovePx: 54,
  compactAbovePx: 62,
} as const;
/** A logo is usually wide; the placeholder takes the typical share of its box. */
const LOGO_HEIGHT_SHARE = 0.62;

/** The skeleton's backdrop, the same veils the loading page has always had. */
export function HomeHeroSkeletonBackdrop() {
  return (
    <>
      <div className="absolute inset-0 bg-zinc-950" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/[0.55] to-black/20" />
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--background)] via-black/10 to-black/[0.24]" />
      <div className="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-[var(--background)] to-transparent" />
    </>
  );
}

/**
 * The placeholders alone, for a stage of a known size. Given the title that
 * will load, the action row reserves exactly its controls: play sized by its
 * own label and time left, and one round placeholder per round button.
 */
export function HomeHeroSkeletonPieces({
  stage,
  withQueue = true,
  withControls = true,
  item,
  smartContinueItems = [],
  canDownload = false,
}: {
  stage: StageSize;
  /** A title's own page has the same copy and no queue. */
  withQueue?: boolean;
  /** The pill over the queue, which a single featured title does without. */
  withControls?: boolean;
  /** The title that will load, when it is already known. */
  item?: MediaItem;
  smartContinueItems?: MediaItem[];
  /**
   * With no title yet: whether a title page's film can be kept offline, so
   * its row carries a download button.
   */
  canDownload?: boolean;
}) {
  const { language, t } = useLanguage();
  const layout = heroLayout(stage, { withQueue });
  const slots = queueSlots(stage);
  const head = slots[0]!;
  const last = slots[slots.length - 1]!;
  const copyTop = stage.height - layout.copy.bottom - layout.copy.height;
  const actionsTop = stage.height - layout.copy.bottom - COPY_ROWS.actionsPx;
  const rest = layout.titleScale.rest;
  const logoWidth = layout.title.width * rest;
  const logoHeight = layout.title.height * rest * LOGO_HEIGHT_SHARE;
  const isCompact = layout.actions === "compact";

  const play = item ? heroPlayState(item, smartContinueItems, t) : null;
  const parts = heroRowParts({
    compact: isCompact,
    onTitlePage: !withQueue,
    isFilm: item ? item.Type === "Movie" : canDownload,
    canStartOver: play?.canStartOver ?? false,
    hasOverview: item
      ? Boolean(getItemDisplayMetadata(item, language).overview)
      : true,
  });
  const rounds = heroRoundCount(parts);
  const timeLeft = play?.progress
    ? t("hero.timeLeft").replace("{time}", play.progress.left)
    : null;
  // A compact row is play, stretched, and the round buttons after it.
  const compactPlayPx =
    layout.copy.width - rounds * (ACTIONS.roundPx + ACTIONS.compactGapPx);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <div
        className="shimmer absolute rounded-lg"
        style={{
          left: layout.title.left,
          bottom: layout.title.bottom,
          width: logoWidth,
          height: logoHeight,
        }}
      />
      <div
        className="absolute flex items-center gap-1 text-sm font-semibold text-white/[0.84]"
        style={{
          left: layout.copy.left,
          top: copyTop,
          height: COPY_ROWS.factsPx,
        }}
      >
        <div className="shimmer h-5 w-10 rounded-md" />.
        <div className="shimmer h-5 w-16 rounded-md" />.
        <div className="shimmer h-5 w-14 rounded-md" />
      </div>
      <div
        className="absolute flex items-center"
        style={{
          left: layout.copy.left,
          top: actionsTop,
          gap: isCompact ? ACTIONS.compactGapPx : ACTIONS.gapPx,
        }}
      >
        {/* A full row's pills are sized by their own, unseen, labels. */}
        {isCompact ? (
          <div
            className="shimmer rounded-full"
            style={{ width: compactPlayPx, height: COPY_ROWS.actionsPx }}
          />
        ) : (
          <div className={`shimmer ${PLAY_PILL}`}>
            <span className="invisible inline-flex items-center gap-2">
              <Play size={19} className="shrink-0" />
              <span>{play?.playLabel ?? t("common.play")}</span>
              {timeLeft ? (
                <span className={PLAY_TIME_LEFT}>{timeLeft}</span>
              ) : null}
            </span>
          </div>
        )}
        {/* In the row's own order: start over comes before "Details". */}
        {Array.from({ length: rounds }, (_, index) => (
          <Fragment key={index}>
            {parts.details === "pill" && index === Number(parts.startOver) ? (
              <div className={`shimmer ${DETAILS_PILL}`}>
                <span className="invisible inline-flex items-center gap-2">
                  <Info size={19} />
                  {t("common.details")}
                </span>
              </div>
            ) : null}
            <div
              className="shimmer rounded-full"
              style={{ width: ACTIONS.roundPx, height: ACTIONS.roundPx }}
            />
          </Fragment>
        ))}
      </div>

      {withQueue ? (
        <>
          {slots.map((slot, index) => (
            <div
              key={index}
              className="shimmer absolute rounded-[12px]"
              style={{
                left: slot.x,
                top: slot.y,
                width: slot.width,
                height: slot.height,
              }}
            />
          ))}
          <div
            className="absolute h-[2px] rounded-full bg-white/15"
            style={{
              left: head.x,
              top: head.y + head.height + 10,
              width: head.width,
            }}
          />
          {withControls ? (
            <div
              className="shimmer absolute rounded-full"
              style={{
                right: stage.width - (last.x + last.width),
                top:
                  head.y -
                  (isCompact ? CONTROLS.compactAbovePx : CONTROLS.abovePx),
                width: isCompact ? CONTROLS.compactWidthPx : CONTROLS.widthPx,
                height: isCompact
                  ? CONTROLS.compactHeightPx
                  : CONTROLS.heightPx,
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The hero-sized loading section, used while the page has no data yet. */
export function HomeHeroSkeleton({ fit = "screen" }: { fit?: HeroFit }) {
  const ref = useRef<HTMLElement>(null);
  const [stage, setStage] = useState<StageSize | null>(null);
  useLayoutEffect(() => {
    const section = ref.current;
    if (!section) return undefined;
    const measure = () =>
      setStage({ width: section.clientWidth, height: section.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={ref}
      className={`relative w-full overflow-hidden ${HERO_HEIGHT_CLASS[fit]}`}
    >
      <HomeHeroSkeletonBackdrop />
      {stage ? <HomeHeroSkeletonPieces stage={stage} /> : null}
    </section>
  );
}

/**
 * A title page's hero while it loads: the home hero's skeleton without the
 * queue, so each placeholder is where the title hero's own piece will be.
 */
export function TitleHeroSkeleton({
  fit = "screen",
  item,
  canDownload = false,
}: {
  fit?: HeroFit;
  /** The title, once the page has it and is waiting on the rest. */
  item?: MediaItem;
  /** Before the title is known: a film this browser can keep offline. */
  canDownload?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const [stage, setStage] = useState<StageSize | null>(null);
  useLayoutEffect(() => {
    const section = ref.current;
    if (!section) return undefined;
    const measure = () =>
      setStage({ width: section.clientWidth, height: section.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={ref}
      className={`relative w-full overflow-hidden ${HERO_HEIGHT_CLASS[fit]}`}
    >
      <HomeHeroSkeletonBackdrop />
      {stage ? (
        <HomeHeroSkeletonPieces
          stage={stage}
          withQueue={false}
          item={item}
          // The page's continue list is not loaded yet; a film knows its
          // own place, and that is what its hero will resume from.
          smartContinueItems={
            item?.Type === "Movie" &&
            (item.UserData?.PlaybackPositionTicks ?? 0) > 0
              ? [item]
              : []
          }
          canDownload={canDownload}
        />
      ) : null}
    </section>
  );
}
