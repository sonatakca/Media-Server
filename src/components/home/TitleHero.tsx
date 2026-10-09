import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "framer-motion";
import { Video, VideoOff, Volume2, VolumeX } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { getHeroPreviewUrl } from "../../lib/mediaApi";
import type { MediaItem } from "../../lib/types";
import {
  readHeroTrailersEnabledPreference,
  saveHeroTrailersEnabledPreference,
} from "../hero/heroModel";
import { HeroComposition, createCompositionMotion } from "./HeroComposition";
import { NavbarVeil } from "./NavbarVeil";
import { HeroControlButton, HeroCopyBlock } from "./HeroCopy";
import type { DrawnSize } from "./useReportedSize";
import {
  HERO_HEIGHT_CLASS,
  HERO_MOTION,
  HERO_TRAILER_DELAY_MS,
  TITLE_SCALE,
  heroDock,
  heroLayout,
  queueSlots,
  stagePlacement,
  type HeroFit,
  type StageSize,
} from "./homeHeroModel";
import { useSmartContinueItems } from "./useSmartContinueItems";

/**
 * A title's own hero, on its film or series page: the home hero's stage with
 * nothing queued. The same composition, bands, logo, copy and actions, the
 * overview on request and the trailer after a while; there is no rotation,
 * so there is nothing to travel.
 */
export function TitleHero({
  item,
  onShowDetails,
  isRevealed = true,
  fit = "screen",
  trailers = true,
}: {
  item: MediaItem;
  /** The screen, or (phone and tablet) the screen above the tab bar. */
  fit?: HeroFit;
  /** Whether the title's trailer may start once its artwork has had a moment. */
  trailers?: boolean;
  /** Scrolls to the title's details further down its page. */
  onShowDetails: () => void;
  /**
   * False while the page keeps the hero hidden behind its skeleton. Nothing
   * fades in until then, or the fades would play unseen and the artwork
   * would arrive at full strength the moment the skeleton goes.
   */
  isRevealed?: boolean;
}) {
  const { t } = useLanguage();
  const reduceMotion = Boolean(useReducedMotion());
  const sectionRef = useRef<HTMLElement | null>(null);
  const [stage, setStage] = useState<StageSize | null>(null);
  const [isArtworkLoaded, setIsArtworkLoaded] = useState(false);
  const isArtworkReady = isArtworkLoaded && isRevealed;
  const smartContinueItems = useSmartContinueItems();
  // One composition for as long as the page shows this title; the page
  // mounts a new hero for a new title.
  const [composition] = useState(() =>
    createCompositionMotion(stagePlacement(), 0),
  );

  // ---------------------------------------------------------------- measure
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return undefined;
    const measure = () => {
      const next = { width: section.clientWidth, height: section.clientHeight };
      setStage((current) =>
        current &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  const layout = stage ? heroLayout(stage, { withQueue: false }) : null;
  const dock = stage ? heroDock(stage, { withQueue: false }) : null;
  const titleScale = layout?.titleScale ?? TITLE_SCALE;
  const slotScale =
    stage && layout ? queueSlots(stage)[0]!.width / stage.width : 0.12;

  // --------------------------------------------------------- the overview
  const [isOverviewHovered, setIsOverviewHovered] = useState(false);
  /** The title as drawn, for the copy's hover target. */
  const [titleSize, setTitleSize] = useState<
    (DrawnSize & { id: string }) | null
  >(null);
  const [isOverviewPinned, setIsOverviewPinned] = useState(false);
  const [isOverviewFocused, setIsOverviewFocused] = useState(false);
  const isOverviewOpen =
    isOverviewHovered || isOverviewPinned || isOverviewFocused;
  const overview = useMotionValue(0);
  const overviewLift = layout?.overviewLift ?? 0;
  const closeOverview = useCallback(() => {
    setIsOverviewHovered(false);
    setIsOverviewPinned(false);
    setIsOverviewFocused(false);
  }, []);
  // One value drives the title's rise and growth and the copy's, as at home.
  useEffect(
    () =>
      overview.on("change", (value) => {
        composition.titleY.set(-value * overviewLift);
        composition.titleScale.set(
          titleScale.rest + (titleScale.open - titleScale.rest) * value,
        );
      }),
    [composition, overview, overviewLift, titleScale],
  );
  // The composition is made before the stage is measured; once its shape is
  // known the title takes that shape's resting size.
  useEffect(() => {
    composition.titleScale.set(
      titleScale.rest + (titleScale.open - titleScale.rest) * overview.get(),
    );
  }, [composition, overview, titleScale]);
  useEffect(() => {
    const controls = animate(overview, isOverviewOpen ? 1 : 0, {
      duration: reduceMotion ? 0 : HERO_MOTION.overviewS,
      ease: HERO_MOTION.travelEase,
    });
    return () => controls.stop();
  }, [isOverviewOpen, overview, reduceMotion]);

  // ---------------------------------------------------------- the trailer
  const [areTrailersEnabled, setAreTrailersEnabled] = useState(
    readHeroTrailersEnabledPreference,
  );
  const [trailerUrl, setTrailerUrl] = useState<string | null>(null);
  const [isTrailerPlaying, setIsTrailerPlaying] = useState(false);
  const [isTrailerMuted, setIsTrailerMuted] = useState(true);
  const [hasTrailerPlayed, setHasTrailerPlayed] = useState(false);
  const [isInView, setIsInView] = useState(true);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    typeof document === "undefined" ? true : !document.hidden,
  );

  useEffect(() => {
    let cancelled = false;
    if (!trailers) return undefined;
    void getHeroPreviewUrl(item)
      .then((url) => {
        if (!cancelled) setTrailerUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item, trailers]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) =>
        setIsInView(
          Boolean(entry?.isIntersecting && entry.intersectionRatio > 0.35),
        ),
      { threshold: [0, 0.35, 0.6] },
    );
    observer.observe(section);
    const onVisibility = () => setIsDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Artwork and copy first; then, once, the title steps back and the picture
  // starts moving. Reading the overview holds it off.
  useEffect(() => {
    if (
      !trailerUrl ||
      !areTrailersEnabled ||
      hasTrailerPlayed ||
      !isArtworkReady ||
      isOverviewOpen
    )
      return undefined;
    const timer = window.setTimeout(() => {
      setHasTrailerPlayed(true);
      setIsTrailerPlaying(true);
    }, HERO_TRAILER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    areTrailersEnabled,
    hasTrailerPlayed,
    isArtworkReady,
    isOverviewOpen,
    trailerUrl,
  ]);

  useEffect(() => {
    const options = {
      duration: reduceMotion ? 0 : 0.8,
      ease: HERO_MOTION.travelEase,
    };
    void animate(composition.trailer, isTrailerPlaying ? 1 : 0, options);
    void animate(
      composition.titleScale,
      isTrailerPlaying ? titleScale.trailer : titleScale.rest,
      options,
    );
  }, [composition, isTrailerPlaying, reduceMotion, titleScale]);

  const endTrailer = useCallback(() => setIsTrailerPlaying(false), []);
  const copyItem = isArtworkReady && !isTrailerPlaying ? item : null;

  // --------------------------------------------------------------- render
  return (
    <section
      ref={sectionRef}
      className={`seyirlik-hero-stage relative mx-4 mt-2 mb-4 w-[calc(100%-2rem)] rounded-2xl overflow-hidden bg-[#050607] ${HERO_HEIGHT_CLASS[fit]}`}
    >
      <NavbarVeil />
      {stage && layout ? (
        <HeroComposition
          item={item}
          stage={stage}
          titleBox={layout.title}
          logoMaxHeight={
            stage.height -
            layout.menuClearance -
            layout.title.bottom -
            layout.overviewLift
          }
          motion={composition}
          slotScale={slotScale}
          titleRestScale={titleScale.rest}
          zIndex={1}
          isStage
          trailerUrl={trailerUrl}
          isTrailerPlaying={isTrailerPlaying && isInView && isDocumentVisible}
          isTrailerMuted={isTrailerMuted}
          onTrailerEnded={endTrailer}
          onArtworkReady={() => setIsArtworkLoaded(true)}
          onTitleSize={(size) => setTitleSize({ id: item.Id, ...size })}
          isRevealed={isRevealed}
        />
      ) : null}

      {layout && stage ? (
        <HeroCopyBlock
          stage={stage}
          layout={layout}
          item={copyItem}
          titleSize={titleSize?.id === item.Id ? titleSize : null}
          overview={overview}
          isOverviewOpen={isOverviewOpen}
          onHoverIntent={setIsOverviewHovered}
          onFocusWithin={setIsOverviewFocused}
          onToggleOverview={() => {
            if (isOverviewOpen) closeOverview();
            else setIsOverviewPinned(true);
          }}
          onShowDetails={onShowDetails}
          reduceMotion={reduceMotion}
          smartContinueItems={smartContinueItems}
          withQueue={false}
        />
      ) : null}

      {/* With nothing queued, the pill holds only the trailer's controls:
          over the dock where it stands at the right, else level with the
          actions there. */}
      {layout && stage && dock && trailerUrl ? (
        <motion.div
          className="absolute z-[6] flex items-center gap-1 rounded-full border border-white/[0.14] bg-black/60 p-1 text-white shadow-[0_18px_60px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-2xl"
          style={
            layout.form === "wide"
              ? {
                  right: stage.width - dock.left - dock.width,
                  bottom: dock.bottom + dock.height + 12,
                }
              : { right: layout.copy.left, bottom: layout.copy.bottom + 1 }
          }
          initial={{ opacity: 0 }}
          animate={{ opacity: isArtworkReady ? 1 : 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.5, ease: "easeOut" }}
        >
          <HeroControlButton
            label={
              areTrailersEnabled
                ? t("hero.disableTrailers")
                : t("hero.enableTrailers")
            }
            onClick={() => {
              const next = !areTrailersEnabled;
              saveHeroTrailersEnabledPreference(next);
              setAreTrailersEnabled(next);
              if (!next) setIsTrailerPlaying(false);
            }}
          >
            {areTrailersEnabled ? <Video size={16} /> : <VideoOff size={16} />}
          </HeroControlButton>
          {isTrailerPlaying ? (
            <HeroControlButton
              label={isTrailerMuted ? t("player.unmute") : t("player.mute")}
              onClick={() => setIsTrailerMuted((current) => !current)}
            >
              {isTrailerMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </HeroControlButton>
          ) : null}
        </motion.div>
      ) : null}
    </section>
  );
}
