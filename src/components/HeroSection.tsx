import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Info, Play } from "lucide-react";
import { ButtonLink } from "./Button";
import { getBackdropImageUrl, getLogoImageUrl, getPrimaryImageUrl, redactPlaybackUrl } from "../lib/jellyfinApi";
import { formatRuntime, getDisplayTitle, getItemSubtitle } from "../lib/format";
import { getRouteForItem } from "../lib/routes";
import { useLanguage } from "../i18n/LanguageContext";
import type { JellyfinItem } from "../lib/types";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";
import { TimedCarouselIndicators } from "./TimedCarouselIndicators";

interface HeroSectionProps {
  item?: JellyfinItem;
  currentIndex?: number;
  totalItems?: number;
  durationMs?: number;
  progressResetKey?: string | number;
  isPaused?: boolean;
  onTogglePaused?: () => void;
  showPauseButton?: boolean;
  onSelectIndex?: (index: number) => void;
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
      url: getBackdropImageUrl(item.ParentBackdropItemId, item.ParentBackdropImageTags[0], 2200),
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
  progressResetKey,
  isPaused = false,
  onTogglePaused,
  showPauseButton = false,
  onSelectIndex,
}: HeroSectionProps) {
  const { t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const [failedImageUrls, setFailedImageUrls] = useState<string[]>([]);
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const imageCandidates = useMemo(() => getHeroImageCandidates(item), [item]);
  const mediaFormatLabels = useMemo(
    () => ({
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    [t],
  );
  const selectedImage = imageCandidates.find((candidate) => !failedImageUrls.includes(candidate.url));
  const primaryPosterUrl = imageCandidates.find((candidate) => candidate.type === "primary")?.url ?? "";
  const logoUrl = item?.ImageTags?.Logo ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 1100) : "";
  const showSidePoster = Boolean(primaryPosterUrl && selectedImage?.type === "primary");
  const title = item ? getDisplayTitle(item, mediaFormatLabels) : "Seyirlik";
  const runtime = item ? formatRuntime(item.RunTimeTicks, mediaFormatLabels) : null;
  const mediaTypeLabel =
    item?.Type === "Movie"
      ? t("common.movie")
      : item?.Type === "Series"
        ? t("common.series")
        : item?.Type === "BoxSet"
          ? t("common.boxsets")
          : item?.Type;
  const metadata = [item?.ProductionYear, runtime, mediaTypeLabel].filter(Boolean);
  const subtitle = item ? getItemSubtitle(item, mediaFormatLabels) : null;
  const canPlay = item?.Type === "Movie" || item?.Type === "Episode" || item?.MediaType === "Video";
  const easeOut: [number, number, number, number] = [0.16, 1, 0.3, 1];
  const softEase: [number, number, number, number] = [0.25, 1, 0.5, 1];
  const heroImageLoaded = Boolean(selectedImage && loadedImageUrl === selectedImage.url);
  const heroContentVisible = !selectedImage || heroImageLoaded;
  const contentKey = item?.Id ?? "hero-fallback";
  const carouselItemCount = totalItems;
  const showCarouselDots = carouselItemCount > 1;
  const activeCarouselIndex = Math.min(Math.max(currentIndex, 0), Math.max(carouselItemCount - 1, 0));

  useEffect(() => {
    setFailedImageUrls([]);
  }, [item?.Id]);

  useEffect(() => {
    if (!import.meta.env.DEV || !item) {
      return;
    }

    console.debug("[Seyirlik Hero] selected featured artwork", {
      name: item.Name,
      id: item.Id,
      hasBackdropImageTags: Boolean(item.BackdropImageTags?.[0] || item.ParentBackdropImageTags?.[0]),
      hasPrimaryImage: Boolean(item.ImageTags?.Primary),
      selectedHeroImageType: selectedImage?.type ?? "fallback",
      selectedHeroImageUrl: selectedImage?.url ? redactPlaybackUrl(selectedImage.url) : "gradient-fallback",
    });
  }, [item, selectedImage]);

  const handleImageError = (url: string) => {
    setFailedImageUrls((currentUrls) => (currentUrls.includes(url) ? currentUrls : [...currentUrls, url]));
  };

  return (
    <section className="relative -mx-4 -mt-6 mb-0 h-[58svh] overflow-hidden bg-zinc-950 sm:-mx-6 md:h-[68svh] lg:-mx-8 lg:h-[72svh]">
      <div className="absolute inset-0 z-0 bg-[linear-gradient(145deg,#18181b_0%,#09090b_52%,#050506_100%)]" />
      <AnimatePresence initial>
        {selectedImage ? (
          <motion.img
            key={selectedImage.url}
            src={selectedImage.url}
            alt=""
            className={`absolute inset-0 z-0 h-full w-full object-cover ${
              selectedImage.type === "primary" ? "blur-2xl" : ""
            }`}
            initial={{
              opacity: 0,
              scale: shouldReduceMotion ? 1 : selectedImage.type === "primary" ? 1.16 : 1.07,
              filter: shouldReduceMotion ? "none" : "blur(18px)",
            }}
            animate={{
              opacity: heroImageLoaded ? (selectedImage.type === "primary" ? 0.52 : 0.78) : 0,
              scale: heroImageLoaded
                ? selectedImage.type === "primary"
                  ? 1.1
                  : 1
                : shouldReduceMotion
                  ? 1
                  : selectedImage.type === "primary"
                    ? 1.13
                    : 1.04,
              filter: heroImageLoaded || shouldReduceMotion ? "none" : "blur(16px)",
            }}
            exit={{
              opacity: 0,
              scale: shouldReduceMotion ? 1 : selectedImage.type === "primary" ? 1.12 : 1.035,
              filter: shouldReduceMotion ? "none" : "blur(16px)",
            }}
            transition={{ duration: shouldReduceMotion ? 0 : 1.45, ease: softEase }}
            onLoad={() => setLoadedImageUrl(selectedImage.url)}
            onError={() => handleImageError(selectedImage.url)}
          />
        ) : null}
      </AnimatePresence>
      <div className="absolute inset-0 z-10 bg-gradient-to-r from-black/90 via-black/[0.55] to-black/20" />
      <div className="absolute inset-0 z-10 bg-gradient-to-t from-[var(--background)] via-black/10 to-black/[0.24]" />
      <div className="absolute bottom-0 left-0 right-0 z-10 h-40 bg-gradient-to-t from-[var(--background)] to-transparent" />

      <div className="relative z-20 mx-auto flex h-[58svh] max-w-[1600px] flex-col justify-end px-4 pb-16 pt-28 sm:h-[68svh] sm:px-6 md:pb-20 lg:h-[72svh] lg:px-8">
        {showSidePoster ? (
          <motion.div
            className="pointer-events-none absolute bottom-20 right-8 hidden w-[min(26vw,21rem)] overflow-hidden rounded-3xl border border-white/[0.12] bg-black/[0.35] shadow-[0_30px_130px_rgba(0,0,0,0.65)] lg:block"
            initial={false}
            animate={{
              opacity: heroContentVisible ? 1 : 0,
              y: heroContentVisible ? 0 : 18,
              scale: heroContentVisible ? 1 : 0.985,
            }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.55, delay: shouldReduceMotion ? 0 : 0.12, ease: easeOut }}
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
            className="max-w-3xl"
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
              filter: heroContentVisible || shouldReduceMotion ? "none" : "blur(10px)",
            }}
            exit={{
              opacity: 0,
              y: shouldReduceMotion ? 0 : -16,
              scale: shouldReduceMotion ? 1 : 0.992,
              filter: shouldReduceMotion ? "none" : "blur(10px)",
            }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.5, delay: shouldReduceMotion ? 0 : 0.18, ease: softEase }}
          >
            {logoUrl ? (
              <motion.img
                src={logoUrl}
                alt={title}
                draggable={false}
                className="max-h-36 max-w-[min(42rem,92vw)] select-none object-contain object-left drop-shadow-[0_16px_42px_rgba(0,0,0,0.85)] sm:max-h-44 lg:max-h-52"
                initial={{ opacity: 0, y: shouldReduceMotion ? 0 : 20, scale: shouldReduceMotion ? 1 : 0.975 }}
                animate={{ opacity: heroContentVisible ? 1 : 0, y: heroContentVisible ? 0 : 14, scale: heroContentVisible ? 1 : 0.985 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.72, delay: shouldReduceMotion ? 0 : 0.28, ease: softEase }}
              />
            ) : (
              <motion.h1
                className="max-w-3xl text-5xl font-black leading-[0.95] text-white drop-shadow-2xl sm:text-6xl lg:text-7xl"
                initial={{ opacity: 0, y: shouldReduceMotion ? 0 : 20, scale: shouldReduceMotion ? 1 : 0.975 }}
                animate={{ opacity: heroContentVisible ? 1 : 0, y: heroContentVisible ? 0 : 14, scale: heroContentVisible ? 1 : 0.985 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.72, delay: shouldReduceMotion ? 0 : 0.28, ease: softEase }}
              >
                {title}
              </motion.h1>
            )}
            {subtitle ? (
              <motion.p
                className="mt-4 text-lg font-semibold text-white/[0.78]"
                initial={false}
                animate={{ opacity: heroContentVisible ? 1 : 0, y: heroContentVisible ? 0 : 10 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.62, delay: shouldReduceMotion ? 0 : 0.36, ease: softEase }}
              >
                {subtitle}
              </motion.p>
            ) : null}
            {metadata.length > 0 ? (
              <motion.div
                className="mt-5 flex flex-wrap gap-2"
                initial={false}
                animate={{ opacity: heroContentVisible ? 1 : 0, y: heroContentVisible ? 0 : 10 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.62, delay: shouldReduceMotion ? 0 : 0.42, ease: softEase }}
              >
                {metadata.map((value) => (
                  <span
                    key={String(value)}
                    className="rounded-full border border-white/[0.12] bg-black/[0.32] px-3 py-1.5 text-sm font-semibold text-white/[0.82] backdrop-blur"
                  >
                    {value}
                  </span>
                ))}
                {item?.Genres?.slice(0, 3).map((genre) => (
                  <span
                    key={genre}
                    className="rounded-full border border-white/[0.12] bg-black/[0.32] px-3 py-1.5 text-sm font-semibold text-white/70 backdrop-blur"
                  >
                    {genre}
                  </span>
                ))}
              </motion.div>
            ) : null}
            {item?.Overview ? (
              <motion.p
                className="mt-5 line-clamp-3 max-w-2xl text-base leading-7 text-white/[0.76] sm:text-lg"
                initial={false}
                animate={{ opacity: heroContentVisible ? 1 : 0, y: heroContentVisible ? 0 : 10 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.66, delay: shouldReduceMotion ? 0 : 0.48, ease: softEase }}
              >
                {item.Overview}
              </motion.p>
            ) : (
              <motion.p
                className="mt-5 max-w-2xl text-base leading-7 text-white/[0.76] sm:text-lg"
                initial={false}
                animate={{ opacity: heroContentVisible ? 1 : 0, y: heroContentVisible ? 0 : 10 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.66, delay: shouldReduceMotion ? 0 : 0.48, ease: softEase }}
              >
                {t("hero.fallbackDescription")}
              </motion.p>
            )}
            <motion.div
              className="mt-7 flex flex-wrap gap-3"
              initial={false}
              animate={{ opacity: heroContentVisible ? 1 : 0, y: heroContentVisible ? 0 : 10 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.66, delay: shouldReduceMotion ? 0 : 0.56, ease: softEase }}
            >
              {item ? (
                <>
                  {canPlay ? (
                    <ButtonLink to={`/watch/${item.Id}`} className="min-h-12 rounded-full px-6 text-base shadow-2xl">
                      <Play size={20} fill="currentColor" />
                      <AnimatedWidth value={t("common.play")}>
                        <AnimatedText value={t("common.play")} />
                      </AnimatedWidth>
                    </ButtonLink>
                  ) : null}
                  <ButtonLink to={getRouteForItem(item)} variant="secondary" className="min-h-12 rounded-full px-6 text-base backdrop-blur">
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
        {showCarouselDots ? (
          <motion.div
            layout
            className="mt-6 w-fit max-w-full"
            initial={{
              opacity: 0,
              y: shouldReduceMotion ? 0 : 10,
              scale: shouldReduceMotion ? 1 : 0.97,
              filter: shouldReduceMotion ? "none" : "blur(8px)",
            }}
            animate={{
              opacity: heroContentVisible ? 1 : 0,
              y: heroContentVisible ? 0 : 10,
              scale: heroContentVisible ? 1 : 0.97,
              filter: heroContentVisible || shouldReduceMotion ? "none" : "blur(8px)",
            }}
            transition={{
              duration: shouldReduceMotion ? 0 : 0.62,
              delay: shouldReduceMotion ? 0 : 0.72,
              ease: softEase,
            }}
          >
            <TimedCarouselIndicators
              count={carouselItemCount}
              activeIndex={activeCarouselIndex}
              durationMs={durationMs}
              onSelect={(index) => onSelectIndex?.(index)}
              isPaused={isPaused}
              progressResetKey={progressResetKey}
              onTogglePaused={onTogglePaused}
              showPauseButton={showPauseButton}
              ariaLabel="Featured carousel"
            />
          </motion.div>
        ) : null}
      </div>
    </section>
  );
}
