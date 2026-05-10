import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Info, Play, Sparkles } from "lucide-react";
import { ButtonLink } from "./Button";
import appIcon from "../assets/AppIcon2.png";
import { getBackdropImageUrl, getLogoImageUrl, getPrimaryImageUrl, redactPlaybackUrl } from "../lib/jellyfinApi";
import { formatRuntime, getDisplayTitle, getItemSubtitle } from "../lib/format";
import { getRouteForItem } from "../lib/routes";
import { useLanguage } from "../i18n/LanguageContext";
import type { JellyfinItem } from "../lib/types";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";

interface HeroSectionProps {
  item?: JellyfinItem;
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

export function HeroSection({ item }: HeroSectionProps) {
  const { t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const [failedImageUrls, setFailedImageUrls] = useState<string[]>([]);
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
  const easeOut: [number, number, number, number] = [0.22, 1, 0.36, 1];

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
      {selectedImage ? (
        <motion.img
          src={selectedImage.url}
          alt=""
          className={`absolute inset-0 z-0 h-full w-full object-cover ${
            selectedImage.type === "primary" ? "blur-2xl opacity-[0.52]" : "opacity-[0.78]"
          }`}
          initial={shouldReduceMotion ? false : { scale: selectedImage.type === "primary" ? 1.13 : 1.04, opacity: 0.45 }}
          animate={shouldReduceMotion ? undefined : { scale: selectedImage.type === "primary" ? 1.1 : 1, opacity: selectedImage.type === "primary" ? 0.52 : 0.78 }}
          transition={{ duration: 0.62, ease: easeOut }}
          onError={() => handleImageError(selectedImage.url)}
        />
      ) : (
        <div className="absolute inset-0 z-0 bg-[linear-gradient(145deg,#18181b_0%,#09090b_52%,#050506_100%)]" />
      )}
      <div className="absolute inset-0 z-10 bg-gradient-to-r from-black/90 via-black/[0.55] to-black/20" />
      <div className="absolute inset-0 z-10 bg-gradient-to-t from-[var(--background)] via-black/10 to-black/[0.24]" />
      <div className="absolute bottom-0 left-0 right-0 z-10 h-40 bg-gradient-to-t from-[var(--background)] to-transparent" />

      <div className="relative z-20 mx-auto flex h-[58svh] max-w-[1600px] flex-col justify-end px-4 pb-16 pt-28 sm:h-[68svh] sm:px-6 md:pb-20 lg:h-[72svh] lg:px-8">
        {showSidePoster ? (
          <motion.div
            className="pointer-events-none absolute bottom-20 right-8 hidden w-[min(26vw,21rem)] overflow-hidden rounded-3xl border border-white/[0.12] bg-black/[0.35] shadow-[0_30px_130px_rgba(0,0,0,0.65)] lg:block"
            initial={shouldReduceMotion ? false : { opacity: 0, y: 18, scale: 0.985 }}
            animate={shouldReduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.36, delay: 0.08, ease: easeOut }}
          >
            <img
              src={primaryPosterUrl}
              alt=""
              className="aspect-[2/3] w-full object-cover"
              onError={() => handleImageError(primaryPosterUrl)}
            />
          </motion.div>
        ) : null}
        <motion.div
          className="max-w-3xl"
          initial={shouldReduceMotion ? false : { opacity: 0, y: 18 }}
          animate={shouldReduceMotion ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.38, delay: 0.04, ease: easeOut }}
        >
          <div className="mb-4 inline-flex items-center gap-3 rounded-full border border-[var(--accent-strong)] bg-[var(--accent-soft)] px-3 py-1.5 text-xs font-bold uppercase tracking-[0.2em] text-white backdrop-blur">
            <img src={appIcon} alt="" className="h-6 w-6 rounded-md object-cover" />
            <span className="inline-flex items-center gap-2">
              <Sparkles size={14} />
              <AnimatedWidth value={item ? t("hero.nowStreaming") : t("hero.featured")}>
                <AnimatedText value={item ? t("hero.nowStreaming") : t("hero.featured")} />
              </AnimatedWidth>
            </span>
          </div>
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={title}
              className="max-h-36 max-w-[min(42rem,92vw)] object-contain object-left drop-shadow-[0_16px_42px_rgba(0,0,0,0.85)] sm:max-h-44 lg:max-h-52"
            />
          ) : (
            <h1 className="max-w-3xl text-5xl font-black leading-[0.95] text-white drop-shadow-2xl sm:text-6xl lg:text-7xl">
              {title}
            </h1>
          )}
          {subtitle ? <p className="mt-4 text-lg font-semibold text-white/[0.78]">{subtitle}</p> : null}
          {metadata.length > 0 ? (
            <div className="mt-5 flex flex-wrap gap-2">
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
            </div>
          ) : null}
          {item?.Overview ? (
            <p className="mt-5 line-clamp-3 max-w-2xl text-base leading-7 text-white/[0.76] sm:text-lg">
              {item.Overview}
            </p>
          ) : (
            <p className="mt-5 max-w-2xl text-base leading-7 text-white/[0.76] sm:text-lg">
              {t("hero.fallbackDescription")}
            </p>
          )}
          <div className="mt-7 flex flex-wrap gap-3">
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
          </div>
        </motion.div>
      </div>
    </section>
  );
}
