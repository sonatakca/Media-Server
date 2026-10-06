import { useState, type MouseEvent } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import { useCroppedTransparentImage } from "../../hooks/useCroppedTransparentImage";
import {
  getItemDisplayMetadata,
  getItemLogoUrl,
} from "../../lib/itemMetadataPreferences";
import { getLogoImageUrl } from "../../lib/mediaApi";
import { getPlayTargetForItem } from "../../lib/playTarget";
import { getRouteForItem } from "../../lib/routes";
import type { MediaItem } from "../../lib/types";
import { getHeroImageCandidates } from "../hero/heroModel";
import { HeroActions, heroPlayState } from "../home/HeroActions";
import { HERO_MOTION } from "../home/homeHeroModel";
import { useSmartContinueItems } from "../home/useSmartContinueItems";
import {
  PHONE_TITLE_HERO_ACTIONS,
  PHONE_TITLE_HERO_COPY,
  PHONE_TITLE_HERO_FACTS,
  PHONE_TITLE_HERO_FRAME,
  PHONE_TITLE_HERO_LOGO_BOX,
  PHONE_TITLE_HERO_OVERVIEW,
  PHONE_TITLE_HERO_SECTION,
  phoneTitleFacts,
} from "./phoneTitleHeroRows";

/**
 * A phone's title page hero. The backdrop is shown whole and as it is: the
 * full width at its own 16:9, below the page's furniture (the navbar, then
 * back and the watched pill), with nothing drawn on it: no shade, no fade,
 * no dimming. Everything the old hero laid over the picture (the logo, the
 * facts, the overview and the actions) stands under it, on the room.
 *
 * The rows are fixed in height (`phoneTitleHeroRows`), so the skeleton
 * (`PhoneTitleHeroSkeleton`) takes the same classes and lands to the pixel.
 */

export function PhoneTitleHero({
  item,
  onShowDetails,
  isRevealed = true,
}: {
  item: MediaItem;
  /** Scrolls to the title's details further down its page. */
  onShowDetails: () => void;
  /**
   * False while the page keeps the hero hidden behind its skeleton, so the
   * fades are not spent unseen.
   */
  isRevealed?: boolean;
}) {
  const { language, t } = useLanguage();
  const navigate = useNavigate();
  const reduceMotion = Boolean(useReducedMotion());
  const smartContinueItems = useSmartContinueItems();
  const [failed, setFailed] = useState<string[]>([]);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [isLogoLoaded, setIsLogoLoaded] = useState(false);

  const labels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };
  const metadata = getItemDisplayMetadata(item, language);
  const title = metadata.title ?? item.Name;
  const overview = metadata.overview ?? item.Overview ?? null;
  const facts = phoneTitleFacts(item, labels);

  const artwork = getHeroImageCandidates(item).find(
    (candidate) => !failed.includes(candidate.url),
  );
  const isArtworkShown = Boolean(
    isRevealed && artwork && loadedUrl === artwork.url,
  );
  const fallbackLogoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 1100)
    : "";
  const logoUrl = useCroppedTransparentImage(
    getItemLogoUrl(item, language, fallbackLogoUrl),
  );

  const { playItem, playLabel, shortPlayLabel, canStartOver, progress } =
    heroPlayState(item, smartContinueItems, t);
  const playTo =
    playItem.Type === "Series"
      ? getRouteForItem(playItem)
      : `/watch/${playItem.Id}`;
  const handlePlay = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(await getPlayTargetForItem(playItem));
  };

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
  });

  return (
    <section className={PHONE_TITLE_HERO_SECTION}>
      <div className={`${PHONE_TITLE_HERO_FRAME} bg-white/[0.04]`}>
        {artwork?.type === "backdrop" ? (
          <motion.img
            key={artwork.url}
            src={artwork.url}
            alt=""
            loading="eager"
            decoding="async"
            draggable={false}
            className="absolute inset-0 h-full w-full select-none object-cover"
            initial={false}
            animate={{ opacity: isArtworkShown ? 1 : 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.45, ease: "easeOut" }}
            onLoad={() => setLoadedUrl(artwork.url)}
            onError={() => setFailed((current) => [...current, artwork.url])}
          />
        ) : artwork ? (
          // A title without a backdrop: its poster, whole, on a wash of its
          // own colours rather than cropped to a strip of its middle.
          <motion.div
            key={artwork.url}
            aria-hidden="true"
            className="absolute inset-0"
            initial={false}
            animate={{ opacity: isArtworkShown ? 1 : 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.45, ease: "easeOut" }}
          >
            <img
              src={artwork.url}
              alt=""
              className="absolute inset-0 h-full w-full scale-125 object-cover blur-2xl saturate-150"
            />
            <img
              src={artwork.url}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full select-none object-contain"
              onLoad={() => setLoadedUrl(artwork.url)}
              onError={() => setFailed((current) => [...current, artwork.url])}
            />
          </motion.div>
        ) : null}
      </div>

      <motion.div
        className={PHONE_TITLE_HERO_COPY}
        initial="initial"
        animate={isRevealed ? "animate" : "initial"}
      >
        <motion.h1 variants={line(0)} className={PHONE_TITLE_HERO_LOGO_BOX}>
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={title}
              draggable={false}
              onLoad={() => setIsLogoLoaded(true)}
              onError={() => setIsLogoLoaded(false)}
              className={`block max-h-full max-w-full select-none object-contain object-left-bottom transition-opacity duration-300 ${
                isLogoLoaded ? "opacity-100" : "opacity-0"
              }`}
            />
          ) : (
            <span className="line-clamp-2 text-[2.25rem] font-black leading-[0.95] text-white [font-stretch:78%]">
              {title}
            </span>
          )}
        </motion.h1>
        {facts ? (
          <motion.div variants={line(1)} className={PHONE_TITLE_HERO_FACTS}>
            <p className="truncate text-[0.8125rem] font-bold leading-5 tracking-[0.04em] text-white/[0.72]">
              {facts}
            </p>
          </motion.div>
        ) : null}
        {overview ? (
          <motion.p
            variants={line(1)}
            className={`${PHONE_TITLE_HERO_OVERVIEW} line-clamp-3 text-[0.9375rem] font-medium leading-6 text-white/[0.7]`}
          >
            {overview}
          </motion.p>
        ) : null}
        <div className={PHONE_TITLE_HERO_ACTIONS}>
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
            overviewId=""
            hasOverview={false}
            isOverviewOpen={false}
            onToggleOverview={() => undefined}
            onShowDetails={onShowDetails}
            fade={line(2)}
            compact
          />
        </div>
      </motion.div>
    </section>
  );
}
