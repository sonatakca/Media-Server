import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Info, Play } from "lucide-react";
import { ButtonLink } from "./Button";
import {
  getBackdropImageUrl,
  getLogoImageUrl,
  getPrimaryImageUrl,
  redactPlaybackUrl,
} from "../lib/jellyfinApi";
import { formatRuntime, getDisplayTitle, getItemSubtitle } from "../lib/format";
import { getRouteForItem } from "../lib/routes";
import { useLanguage } from "../i18n/LanguageContext";
import type { JellyfinItem } from "../lib/types";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";

import { TimedCarouselIndicators } from "./TimedCarouselIndicators";

const HERO_DESCRIPTION_VISIBLE_MS = 5000;
const HERO_INDICATOR_AFTER_BANNER_LIMIT_VH = 30;

type IndicatorsPlacement =
  | "top-center"
  | "top-right"
  | "top-left"
  | "top-left-quarter"
  | "top-right-quarter"
  | "bottom-center"
  | "bottom-left"
  | "bottom-right"
  | "bottom-left-quarter"
  | "bottom-right-quarter";

interface HeroSectionProps {
  item?: JellyfinItem;
  currentIndex?: number;
  totalItems?: number;
  durationMs?: number;
  progressStartedAtMs?: number;
  progressResetKey?: string | number;
  isPaused?: boolean;
  onTogglePaused?: () => void;
  showPauseButton?: boolean;
  indicatorPlacement?: IndicatorsPlacement;
  onSelectIndex?: (index: number) => void;
  onHeroReady?: () => void;
}

type HeroImageType = "backdrop" | "primary";

interface HeroImageCandidate {
  type: HeroImageType;
  url: string;
}

function getHeroImageCandidates(item?: JellyfinItem): HeroImageCandidate[] {
  if (!item) {
    return [];
  }

  const candidates: HeroImageCandidate[] = [];

  if (item.BackdropImageTags?.[0]) {
    candidates.push({
      type: "backdrop",
      url: getBackdropImageUrl(item.Id, item.BackdropImageTags[0], 2200),
    });
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    candidates.push({
      type: "backdrop",
      url: getBackdropImageUrl(
        item.ParentBackdropItemId,
        item.ParentBackdropImageTags[0],
        2200,
      ),
    });
  }

  if (item.ImageTags?.Primary) {
    candidates.push({
      type: "primary",
      url: getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 900),
    });
  }

  return candidates;
}

export function HeroSection({
  item,
  currentIndex = 0,
  totalItems = 0,
  durationMs = 12000,
  progressStartedAtMs,
  progressResetKey,
  isPaused = false,
  onTogglePaused,
  showPauseButton = false,
  indicatorPlacement = "bottom-right-quarter",
  onSelectIndex,
  onHeroReady,
}: HeroSectionProps) {
  const { t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const heroSectionRef = useRef<HTMLElement | null>(null);
  const [failedImageUrls, setFailedImageUrls] = useState<string[]>([]);
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const [isHeroIntroDone, setIsHeroIntroDone] = useState(false);
  const [showStickyIndicators, setShowStickyIndicators] = useState(true);
  const [hasHiddenStickyIndicators, setHasHiddenStickyIndicators] =
    useState(false);
  const [isCompactHeroViewport, setIsCompactHeroViewport] = useState(false);
  const imageCandidates = useMemo(() => getHeroImageCandidates(item), [item]);
  const mediaFormatLabels = useMemo(
    () => ({
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    [t],
  );
  const selectedImage = imageCandidates.find(
    (candidate) => !failedImageUrls.includes(candidate.url),
  );
  const primaryPosterUrl =
    imageCandidates.find((candidate) => candidate.type === "primary")?.url ??
    "";
  const logoUrl = item?.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 1100)
    : "";
  const showSidePoster = Boolean(
    primaryPosterUrl && selectedImage?.type === "primary",
  );
  const title = item ? getDisplayTitle(item, mediaFormatLabels) : "Seyirlik";
  const runtime = item
    ? formatRuntime(item.RunTimeTicks, mediaFormatLabels)
    : null;
  const mediaTypeLabel =
    item?.Type === "Movie"
      ? t("common.movie")
      : item?.Type === "Series"
        ? t("common.series")
        : item?.Type === "BoxSet"
          ? t("common.boxsets")
          : item?.Type;
  const metadata = [item?.ProductionYear, runtime, mediaTypeLabel].filter(
    Boolean,
  );
  const subtitle = item ? getItemSubtitle(item, mediaFormatLabels) : null;
  const canPlay =
    item?.Type === "Movie" ||
    item?.Type === "Episode" ||
    item?.MediaType === "Video";
  const easeOut: [number, number, number, number] = [0.16, 1, 0.3, 1];
  const softEase: [number, number, number, number] = [0.25, 1, 0.5, 1];
  const heroImageLoaded = Boolean(
    selectedImage && loadedImageUrl === selectedImage.url,
  );
  const heroContentVisible = !selectedImage || heroImageLoaded;
  const contentKey = item?.Id ?? "hero-fallback";
  const carouselItemCount = totalItems;
  const showCarouselDots = carouselItemCount > 1;
  const activeCarouselIndex = Math.min(
    Math.max(currentIndex, 0),
    Math.max(carouselItemCount - 1, 0),
  );
  const showHeroIndicators = showCarouselDots && showStickyIndicators;
  const indicatorPlacementClasses: Record<IndicatorsPlacement, string> = {
    "top-center":
      "inset-x-0 top-[calc(0.85rem+env(safe-area-inset-top))] justify-center",
    "top-right":
      "inset-x-0 top-[calc(0.85rem+env(safe-area-inset-top))] justify-end",
    "top-left":
      "inset-x-0 top-[calc(0.85rem+env(safe-area-inset-top))] justify-start",
    "top-left-quarter":
      "left-1/4 top-[calc(0.85rem+env(safe-area-inset-top))] -translate-x-1/2 justify-center",
    "top-right-quarter":
      "left-3/4 top-[calc(0.85rem+env(safe-area-inset-top))] -translate-x-1/2 justify-center",
    "bottom-center":
      "inset-x-0 bottom-[calc(0.85rem+env(safe-area-inset-bottom))] justify-center sm:bottom-[calc(clamp(5.75rem,10vh,7.25rem)+env(safe-area-inset-bottom))]",
    "bottom-right":
      "inset-x-0 bottom-[calc(0.85rem+env(safe-area-inset-bottom))] justify-end sm:bottom-[calc(clamp(5.75rem,10vh,7.25rem)+env(safe-area-inset-bottom))]",
    "bottom-left":
      "inset-x-0 bottom-[calc(0.85rem+env(safe-area-inset-bottom))] justify-start sm:bottom-[calc(clamp(5.75rem,10vh,7.25rem)+env(safe-area-inset-bottom))]",
    "bottom-left-quarter":
      "left-1/4 bottom-[calc(0.85rem+env(safe-area-inset-bottom))] -translate-x-1/2 justify-center sm:bottom-[calc(clamp(5.75rem,10vh,7.25rem)+env(safe-area-inset-bottom))]",
    "bottom-right-quarter":
      "left-3/4 bottom-[calc(0.85rem+env(safe-area-inset-bottom))] -translate-x-1/2 justify-center sm:bottom-[calc(clamp(5.75rem,10vh,7.25rem)+env(safe-area-inset-bottom))]",
  };

  const heroIndicators = showCarouselDots ? (
    <AnimatePresence>
      {showHeroIndicators ? (
        <motion.div
          key="hero-carousel-indicators"
          layout
          data-hero-carousel-indicators
          className={`pointer-events-none fixed z-[99999] flex px-3 sm:px-4 ${indicatorPlacementClasses[indicatorPlacement]}`}
          initial={
            hasHiddenStickyIndicators
              ? {
                  opacity: 0,
                  y: 0,
                  scale: 1,
                }
              : {
                  opacity: 0,
                  y: shouldReduceMotion ? 0 : "140%",
                  scale: shouldReduceMotion ? 1 : 0.96,
                }
          }
          animate={{
            opacity: 1,
            y: 0,
            scale: 1,
          }}
          exit={{
            opacity: 0,
            y: shouldReduceMotion ? 0 : "222%",
            scale: shouldReduceMotion ? 1 : 0.96,
          }}
          transition={{
            duration: shouldReduceMotion ? 0 : 1,
            delay: shouldReduceMotion || hasHiddenStickyIndicators ? 0 : 0.1,
            ease: softEase,
          }}
        >
          <div className="pointer-events-auto max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-full border border-white/25 bg-black/80 p-1 shadow-[0_24px_90px_rgba(0,0,0,0.78),0_0_0_1px_rgba(255,255,255,0.08)] sm:max-w-[calc(100vw-2rem)] sm:p-1.5">
            <TimedCarouselIndicators
              count={carouselItemCount}
              activeIndex={activeCarouselIndex}
              durationMs={durationMs}
              progressStartedAtMs={progressStartedAtMs}
              onSelect={(index) => onSelectIndex?.(index)}
              isPaused={isPaused}
              progressResetKey={progressResetKey}
              onTogglePaused={onTogglePaused}
              showPauseButton={showPauseButton}
              maxVisibleDots={9}
              ariaLabel="Featured carousel"
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  ) : null;

  useEffect(() => {
    setFailedImageUrls([]);
  }, [item?.Id]);

  useEffect(() => {
    if (!showCarouselDots) {
      setHasHiddenStickyIndicators(false);
      return;
    }

    if (!showHeroIndicators) {
      setHasHiddenStickyIndicators(true);
    }
  }, [showCarouselDots, showHeroIndicators]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 640px)");
    const updateCompactViewport = () =>
      setIsCompactHeroViewport(mediaQuery.matches);

    updateCompactViewport();
    mediaQuery.addEventListener("change", updateCompactViewport);

    return () => {
      mediaQuery.removeEventListener("change", updateCompactViewport);
    };
  }, []);

  useEffect(() => {
    setIsHeroIntroDone(false);

    if (!item?.Id) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsHeroIntroDone(true);
    }, HERO_DESCRIPTION_VISIBLE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [item?.Id]);

  useEffect(() => {
    if (!heroContentVisible) {
      return;
    }

    onHeroReady?.();
  }, [heroContentVisible, onHeroReady]);

  useEffect(() => {
    const updateStickyIndicatorVisibility = () => {
      const heroSection = heroSectionRef.current;

      if (!heroSection) {
        setShowStickyIndicators(false);
        return;
      }

      const heroRect = heroSection.getBoundingClientRect();
      const heroTop = heroRect.top + window.scrollY;
      const bannerBottom = heroTop + window.innerHeight;
      const indicatorLimit =
        bannerBottom +
        window.innerHeight * (HERO_INDICATOR_AFTER_BANNER_LIMIT_VH / 100);
      const viewportBottom = window.scrollY + window.innerHeight;

      setShowStickyIndicators(viewportBottom <= indicatorLimit);
    };

    updateStickyIndicatorVisibility();
    window.addEventListener("scroll", updateStickyIndicatorVisibility, {
      passive: true,
    });
    window.addEventListener("resize", updateStickyIndicatorVisibility);

    return () => {
      window.removeEventListener("scroll", updateStickyIndicatorVisibility);
      window.removeEventListener("resize", updateStickyIndicatorVisibility);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    const heroRect = heroSectionRef.current?.getBoundingClientRect();
    const bannerBottom =
      heroRect && typeof window !== "undefined"
        ? heroRect.top + window.scrollY + window.innerHeight
        : null;

    console.debug("[Seyirlik Hero] carousel indicators", {
      carouselItemCount,
      showCarouselDots,
      currentIndex,
      activeCarouselIndex,
      featuredItem: item
        ? {
            id: item.Id,
            name: item.Name,
          }
        : null,
      heroContentVisible,
      showStickyIndicators,
      loadedImageUrl: loadedImageUrl
        ? redactPlaybackUrl(loadedImageUrl)
        : loadedImageUrl,
      selectedImageUrl: selectedImage?.url
        ? redactPlaybackUrl(selectedImage.url)
        : selectedImage?.url,
      selectedImageType: selectedImage?.type,
      scrollY: typeof window === "undefined" ? null : window.scrollY,
      viewportBottom:
        typeof window === "undefined"
          ? null
          : window.scrollY + window.innerHeight,
      heroSectionRect: heroRect
        ? {
            top: heroRect.top,
            right: heroRect.right,
            bottom: heroRect.bottom,
            left: heroRect.left,
            width: heroRect.width,
            height: heroRect.height,
          }
        : null,
      bannerBottom,
      indicatorLimit:
        bannerBottom === null || typeof window === "undefined"
          ? null
          : bannerBottom +
            window.innerHeight * (HERO_INDICATOR_AFTER_BANNER_LIMIT_VH / 100),
      indicatorLimitExtraVh: HERO_INDICATOR_AFTER_BANNER_LIMIT_VH,
      reason: showCarouselDots
        ? showStickyIndicators
          ? "Indicators should be mounted and visible."
          : "Indicators are mounted but fading because the viewport bottom is past the hero indicator limit."
        : "Indicators are intentionally not mounted because carouselItemCount <= 1; TimedCarouselIndicators returns null for a single slide.",
    });
  }, [
    activeCarouselIndex,
    carouselItemCount,
    currentIndex,
    heroContentVisible,
    item,
    loadedImageUrl,
    selectedImage?.type,
    selectedImage?.url,
    showCarouselDots,
    showStickyIndicators,
  ]);

  useEffect(() => {
    if (!import.meta.env.DEV || !item) {
      return;
    }

    console.debug("[Seyirlik Hero] selected featured artwork", {
      name: item.Name,
      id: item.Id,
      hasBackdropImageTags: Boolean(
        item.BackdropImageTags?.[0] || item.ParentBackdropImageTags?.[0],
      ),
      hasPrimaryImage: Boolean(item.ImageTags?.Primary),
      selectedHeroImageType: selectedImage?.type ?? "fallback",
      selectedHeroImageUrl: selectedImage?.url
        ? redactPlaybackUrl(selectedImage.url)
        : "gradient-fallback",
    });
  }, [item, selectedImage]);

  const handleImageError = (url: string) => {
    setFailedImageUrls((currentUrls) =>
      currentUrls.includes(url) ? currentUrls : [...currentUrls, url],
    );
  };

  return (
    <>
      <section
        ref={heroSectionRef}
        className="seyirlik-hero-section relative mb-0 min-h-[min(100svh,44rem)] w-full overflow-hidden bg-zinc-950 sm:min-h-screen"
      >
        <div className="absolute inset-0 z-0 bg-[linear-gradient(145deg,#18181b_0%,#09090b_52%,#050506_100%)]" />
        <AnimatePresence initial>
          {selectedImage ? (
            <motion.img
              key={selectedImage.url}
              src={selectedImage.url}
              alt=""
              className={`seyirlik-hero-artwork absolute inset-0 z-0 h-full w-full object-cover ${
                selectedImage.type === "primary" ? "blur-2xl" : ""
              }`}
              initial={{
                opacity: 0,
                scale: shouldReduceMotion
                  ? 1
                  : selectedImage.type === "primary"
                    ? 1.16
                    : 1.07,
                filter: shouldReduceMotion ? "none" : "blur(18px)",
              }}
              animate={{
                opacity: heroImageLoaded
                  ? selectedImage.type === "primary"
                    ? 0.52
                    : 0.78
                  : 0,
                scale: heroImageLoaded
                  ? selectedImage.type === "primary"
                    ? 1.1
                    : 1
                  : shouldReduceMotion
                    ? 1
                    : selectedImage.type === "primary"
                      ? 1.13
                      : 1.04,
                filter:
                  heroImageLoaded || shouldReduceMotion ? "none" : "blur(16px)",
              }}
              exit={{
                opacity: 0,
                scale: shouldReduceMotion
                  ? 1
                  : selectedImage.type === "primary"
                    ? 1.12
                    : 1.035,
                filter: shouldReduceMotion ? "none" : "blur(16px)",
              }}
              transition={{
                duration: shouldReduceMotion ? 0 : 1.45,
                ease: softEase,
              }}
              onLoad={() => setLoadedImageUrl(selectedImage.url)}
              onError={() => handleImageError(selectedImage.url)}
            />
          ) : null}
        </AnimatePresence>
        <motion.div
          className="hero-cinematic-vignette z-10"
          initial={false}
          animate={{
            opacity: isHeroIntroDone ? 0.58 : 1,
          }}
          transition={{
            duration: shouldReduceMotion ? 0 : 1.25,
            ease: softEase,
          }}
        />
        <div className="hero-bottom-fade z-10" />

        <div className="seyirlik-hero-content relative z-20 mx-auto flex min-h-[min(100svh,44rem)] w-full max-w-[1600px] flex-col justify-end px-4 pb-[calc(6.75rem+env(safe-area-inset-bottom))] pt-20 sm:min-h-screen sm:px-6 sm:pb-[clamp(3rem,8vh,6rem)] sm:pt-28 lg:px-8">
          {showSidePoster ? (
            <motion.div
              className="artwork-edge-vignette pointer-events-none absolute bottom-20 right-8 hidden w-[min(26vw,21rem)] overflow-hidden rounded-3xl border border-white/[0.12] bg-black/[0.35] shadow-artwork-glow lg:block"
              initial={false}
              animate={{
                opacity: heroContentVisible ? 1 : 0,
                y: heroContentVisible ? 0 : 18,
                scale: heroContentVisible ? 1 : 0.985,
              }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.55,
                delay: shouldReduceMotion ? 0 : 0.12,
                ease: easeOut,
              }}
            >
              <img
                src={primaryPosterUrl}
                alt=""
                className="aspect-[2/3] w-full object-cover"
                onError={() => handleImageError(primaryPosterUrl)}
              />
            </motion.div>
          ) : null}
          <AnimatePresence mode="wait" initial>
            <motion.div
              key={contentKey}
              className="max-w-[min(32rem,88vw)] sm:max-w-3xl"
              initial={{
                opacity: 0,
                y: shouldReduceMotion ? 0 : 28,
                scale: shouldReduceMotion ? 1 : 0.982,
                filter: shouldReduceMotion ? "none" : "blur(14px)",
              }}
              animate={{
                opacity: heroContentVisible ? 1 : 0,
                y: heroContentVisible || shouldReduceMotion ? 0 : 18,
                scale: heroContentVisible || shouldReduceMotion ? 1 : 0.982,
                filter:
                  heroContentVisible || shouldReduceMotion
                    ? "none"
                    : "blur(10px)",
              }}
              exit={{
                opacity: 0,
                y: shouldReduceMotion ? 0 : -16,
                scale: shouldReduceMotion ? 1 : 0.992,
                filter: shouldReduceMotion ? "none" : "blur(10px)",
              }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.5,
                delay: shouldReduceMotion ? 0 : 0.18,
                ease: softEase,
              }}
            >
              {logoUrl ? (
                <motion.img
                  src={logoUrl}
                  alt={title}
                  draggable={false}
                  className="cinematic-logo-shadow h-[clamp(5rem,22vw,8rem)] max-w-[min(24rem,70vw)] origin-left select-none object-contain object-left sm:h-[clamp(8rem,18vw,18rem)] sm:max-w-[min(44rem,72vw)]"
                  initial={{
                    opacity: 0,
                    y: shouldReduceMotion ? 0 : 20,
                    scale: shouldReduceMotion ? 1 : 0.975,
                  }}
                  animate={{
                    opacity: heroContentVisible ? 1 : 0,
                    y: heroContentVisible
                      ? isHeroIntroDone
                        ? isCompactHeroViewport
                          ? 72
                          : 180
                        : 0
                      : 14,
                    scale: heroContentVisible
                      ? isHeroIntroDone
                        ? isCompactHeroViewport
                          ? 0.74
                          : 0.68
                        : 1
                      : 0.985,
                  }}
                  transition={{
                    duration: shouldReduceMotion
                      ? 0
                      : isHeroIntroDone
                        ? 1.35
                        : 0.9,
                    delay: shouldReduceMotion ? 0 : isHeroIntroDone ? 0 : 0.28,
                    ease: softEase,
                  }}
                />
              ) : (
                <motion.h1
                  className="text-cinematic-title max-w-3xl origin-left text-4xl font-black leading-[0.95] text-white sm:text-6xl lg:text-7xl"
                  initial={{
                    opacity: 0,
                    y: shouldReduceMotion ? 0 : 20,
                    scale: shouldReduceMotion ? 1 : 0.975,
                  }}
                  animate={{
                    opacity: heroContentVisible ? 1 : 0,
                    y: heroContentVisible
                      ? isHeroIntroDone
                        ? isCompactHeroViewport
                          ? 42
                          : 64
                        : 0
                      : 14,
                    scale: heroContentVisible
                      ? isHeroIntroDone
                        ? 0.78
                        : 1
                      : 0.985,
                  }}
                  transition={{
                    duration: shouldReduceMotion
                      ? 0
                      : isHeroIntroDone
                        ? 1.35
                        : 0.9,
                    delay: shouldReduceMotion ? 0 : isHeroIntroDone ? 0 : 0.28,
                    ease: softEase,
                  }}
                >
                  {title}
                </motion.h1>
              )}
              {item?.Overview ? (
                <motion.p
                  className="mt-3 line-clamp-3 max-w-2xl text-sm leading-6 text-white/[0.76] sm:mt-5 sm:text-lg sm:leading-7"
                  initial={false}
                  animate={{
                    opacity: heroContentVisible && !isHeroIntroDone ? 1 : 0,
                    y: heroContentVisible ? (isHeroIntroDone ? 26 : 0) : 10,
                    filter:
                      heroContentVisible && !isHeroIntroDone
                        ? "blur(0px)"
                        : "blur(0px)",
                  }}
                  transition={{
                    duration: shouldReduceMotion
                      ? 0
                      : isHeroIntroDone
                        ? 1.15
                        : 0.78,
                    delay: shouldReduceMotion ? 0 : isHeroIntroDone ? 0 : 0.48,
                    ease: softEase,
                  }}
                  style={{
                    pointerEvents: isHeroIntroDone ? "none" : "auto",
                  }}
                >
                  {item.Overview}
                </motion.p>
              ) : (
                <motion.p
                  className="mt-3 max-w-2xl text-sm leading-6 text-white/[0.76] sm:mt-5 sm:text-lg sm:leading-7"
                  initial={false}
                  animate={{
                    opacity: heroContentVisible && !isHeroIntroDone ? 1 : 0,
                    y: heroContentVisible ? (isHeroIntroDone ? 26 : 0) : 10,
                    filter:
                      heroContentVisible && !isHeroIntroDone
                        ? "blur(0px)"
                        : "blur(0px)",
                  }}
                  transition={{
                    duration: shouldReduceMotion
                      ? 0
                      : isHeroIntroDone
                        ? 1.15
                        : 0.78,
                    delay: shouldReduceMotion ? 0 : isHeroIntroDone ? 0 : 0.48,
                    ease: softEase,
                  }}
                  style={{
                    pointerEvents: isHeroIntroDone ? "none" : "auto",
                  }}
                >
                  {t("hero.fallbackDescription")}
                </motion.p>
              )}
              {subtitle && false ? (
                <motion.p
                  className="mt-4 text-lg font-semibold text-white/[0.78]"
                  initial={false}
                  animate={{
                    opacity: heroContentVisible ? 1 : 0,
                    y: heroContentVisible ? 0 : 10,
                  }}
                  transition={{
                    duration: shouldReduceMotion ? 0 : 0.62,
                    delay: shouldReduceMotion ? 0 : 0.36,
                    ease: softEase,
                  }}
                >
                  {subtitle}
                </motion.p>
              ) : null}
              {metadata.length > 0 ? (
                <motion.div
                  className="mt-4 flex flex-wrap gap-1.5 sm:mt-5 sm:gap-2"
                  initial={false}
                  animate={{
                    opacity: heroContentVisible && !isHeroIntroDone ? 1 : 0,
                    y: heroContentVisible ? (isHeroIntroDone ? 26 : 0) : 10,
                  }}
                  transition={{
                    duration: shouldReduceMotion
                      ? 0
                      : isHeroIntroDone
                        ? 1.15
                        : 0.74,
                    delay: shouldReduceMotion ? 0 : isHeroIntroDone ? 0 : 0.42,
                    ease: softEase,
                  }}
                  style={{
                    pointerEvents: isHeroIntroDone ? "none" : "auto",
                  }}
                >
                  {metadata.map((value) => (
                    <span
                      key={String(value)}
                      className="rounded-full border border-white/[0.12] bg-black/[0.32] px-2.5 py-1 text-xs font-semibold text-white/[0.82] backdrop-blur sm:px-3 sm:py-1.5 sm:text-sm"
                    >
                      {value}
                    </span>
                  ))}
                  {item?.Genres?.slice(0, 3).map((genre) => (
                    <span
                      key={genre}
                      className="rounded-full border border-white/[0.12] bg-black/[0.32] px-2.5 py-1 text-xs font-semibold text-white/70 backdrop-blur sm:px-3 sm:py-1.5 sm:text-sm"
                    >
                      {genre}
                    </span>
                  ))}
                </motion.div>
              ) : null}
              <motion.div
                className="mt-5 flex flex-wrap gap-2.5 sm:mt-7 sm:gap-3"
                initial={false}
                animate={{
                  opacity: heroContentVisible ? 1 : 0,
                  y: heroContentVisible ? (isHeroIntroDone ? -18 : 0) : 10,
                }}
                transition={{
                  duration: shouldReduceMotion
                    ? 0
                    : isHeroIntroDone
                      ? 1.05
                      : 0.84,
                  delay: shouldReduceMotion ? 0 : isHeroIntroDone ? 0.08 : 0.56,
                  ease: softEase,
                }}
              >
                {item ? (
                  <>
                    {canPlay ? (
                      <ButtonLink
                        to={`/watch/${item.Id}`}
                        className="min-h-10 rounded-full px-4 text-sm shadow-button-glow sm:min-h-12 sm:px-6 sm:text-base"
                      >
                        <Play size={20} fill="currentColor" />
                        <AnimatedWidth value={t("common.play")}>
                          <AnimatedText value={t("common.play")} />
                        </AnimatedWidth>
                      </ButtonLink>
                    ) : null}
                    <ButtonLink
                      to={getRouteForItem(item)}
                      variant="secondary"
                      className="min-h-10 rounded-full px-4 text-sm backdrop-blur sm:min-h-12 sm:px-6 sm:text-base"
                    >
                      <Info size={20} />
                      <AnimatedWidth value={t("common.details")}>
                        <AnimatedText value={t("common.details")} />
                      </AnimatedWidth>
                    </ButtonLink>
                  </>
                ) : null}
              </motion.div>
            </motion.div>
          </AnimatePresence>
        </div>
      </section>
      {typeof document === "undefined"
        ? heroIndicators
        : createPortal(heroIndicators, document.body)}
    </>
  );
}
