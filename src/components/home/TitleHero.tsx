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
import { HeroControlButton, HeroCopyBlock } from "./HeroCopy";
import {
  HANDOVER_GRADIENT,
  HERO_MOTION,
  HERO_TRAILER_DELAY_MS,
  LOGO_MENU_CLEARANCE_PX,
  TITLE_SCALE,
  heroLayout,
  queueSlots,
  stagePlacement,
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
}: {
  item: MediaItem;
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
  const layout = stage ? heroLayout(stage) : null;
  const slotScale =
    stage && layout ? queueSlots(stage)[0]!.width / stage.width : 0.12;

  // --------------------------------------------------------- the overview
  const [isOverviewHovered, setIsOverviewHovered] = useState(false);
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
          TITLE_SCALE.rest + (TITLE_SCALE.open - TITLE_SCALE.rest) * value,
        );
      }),
    [composition, overview, overviewLift],
  );
  useEffect(() => {
    const controls = animate(overview, isOverviewOpen ? 1 : 0, {
      duration: reduceMotion ? 0 : 0.32,
      ease: isOverviewOpen ? HERO_MOTION.settleEase : HERO_MOTION.travelEase,
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
    void getHeroPreviewUrl(item)
      .then((url) => {
        if (!cancelled) setTrailerUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item]);

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
      isTrailerPlaying ? TITLE_SCALE.trailer : TITLE_SCALE.rest,
      options,
    );
  }, [composition, isTrailerPlaying, reduceMotion]);

  const endTrailer = useCallback(() => setIsTrailerPlaying(false), []);
  const copyItem = isArtworkReady && !isTrailerPlaying ? item : null;

  // --------------------------------------------------------------- render
  return (
    <section
      ref={sectionRef}
      className="relative h-[100svh] min-h-[38rem] w-full overflow-hidden bg-[#050607]"
    >
      {stage && layout ? (
        <HeroComposition
          item={item}
          stage={stage}
          titleBox={layout.title}
          logoMaxHeight={
            stage.height -
            LOGO_MENU_CLEARANCE_PX -
            layout.title.bottom -
            layout.overviewLift
          }
          motion={composition}
          slotScale={slotScale}
          zIndex={1}
          isStage
          trailerUrl={trailerUrl}
          isTrailerPlaying={isTrailerPlaying && isInView && isDocumentVisible}
          isTrailerMuted={isTrailerMuted}
          onTrailerEnded={endTrailer}
          onArtworkReady={() => setIsArtworkLoaded(true)}
          isRevealed={isRevealed}
        />
      ) : null}

      {layout && stage ? (
        <HeroCopyBlock
          stage={stage}
          layout={layout}
          item={copyItem}
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
        />
      ) : null}

      {/* With nothing queued, the pill holds only the trailer's controls,
          level with the actions at the right. */}
      {layout && trailerUrl ? (
        <motion.div
          className="absolute z-[6] flex items-center gap-1 rounded-full border border-white/[0.14] bg-black/60 p-1 text-white shadow-[0_18px_60px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-2xl"
          style={{ right: layout.copy.left, bottom: layout.copy.bottom + 1 }}
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

      {/* The page continues below; the hero hands over to it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] h-[12%]"
        style={{ background: HANDOVER_GRADIENT }}
      />
    </section>
  );
}
