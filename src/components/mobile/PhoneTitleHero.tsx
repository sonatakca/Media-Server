import { useState, type MouseEvent } from "react";
import { Play, RotateCcw } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
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
import { FavouriteButton } from "../FavouriteButton";
import { DownloadButton } from "../offline/DownloadButton";
import { isOfflineSupported } from "../../lib/offline/offlineLibrary";
import {
  HERO_FOCUS,
  HERO_PLAY,
  HERO_PRESS,
  PLAY_TIME_LEFT,
  heroPlayState,
} from "../home/HeroActions";
import { HERO_MOTION } from "../home/homeHeroModel";
import { stageLogoFilter, useLogoShadow } from "../home/logoShadowStyle";
import { useSmartContinueItems } from "../home/useSmartContinueItems";
import {
  PHONE_TITLE_HERO_ACTION,
  PHONE_TITLE_HERO_ACTION_SLOT,
  PHONE_TITLE_HERO_ACTIONS,
  PHONE_TITLE_HERO_COPY,
  PHONE_TITLE_HERO_FACTS,
  PHONE_TITLE_HERO_FRAME,
  PHONE_TITLE_HERO_LOGO_BOX,
  PHONE_TITLE_HERO_OVERVIEW,
  PHONE_TITLE_HERO_PICTURE,
  PHONE_TITLE_HERO_PLAY,
  PHONE_TITLE_HERO_ROW,
  PHONE_TITLE_HERO_SECTION,
  PHONE_TITLE_ACTION_ICON,
  PHONE_TITLE_LOGO_REGION,
  PHONE_TITLE_PICTURE_FADE,
  phoneTitleFacts,
} from "./phoneTitleHeroRows";

/**
 * A phone's title page hero. The backdrop starts under the navbar and runs
 * the full width, with no shade, fade or dimming on it; the only thing
 * drawn on the picture is the title's logo, at its foot on the left,
 * standing on the same halo the desktop stage gives it (measured against
 * the picture behind it), and back, over its corner. The facts, the
 * overview and the actions stand under the picture, on the room: play the
 * full width, naming the time left when the title is under way, and under
 * it start over, My List, watched and download, each a mark over its name.
 *
 * The rows are fixed in height (`phoneTitleHeroRows`), so the skeleton
 * (`PhoneTitleHeroSkeleton`) takes the same classes and lands to the pixel.
 */

export function PhoneTitleHero({
  item,
  onWatchedSlot,
  isRevealed = true,
}: {
  item: MediaItem;
  /**
   * The action row's place for the watched button, which the page's details
   * render there, since they hold whether the title is watched.
   */
  onWatchedSlot?: (element: HTMLSpanElement | null) => void;
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
  const logoShadow = useLogoShadow(
    logoUrl,
    artwork?.url,
    PHONE_TITLE_LOGO_REGION,
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
      <div className={PHONE_TITLE_HERO_FRAME}>
        <div className={PHONE_TITLE_HERO_PICTURE}>
          <div
            className="absolute inset-0 bg-white/[0.04]"
            style={{
              WebkitMaskImage: PHONE_TITLE_PICTURE_FADE,
              maskImage: PHONE_TITLE_PICTURE_FADE,
            }}
          >
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
                transition={{
                  duration: reduceMotion ? 0 : 0.45,
                  ease: "easeOut",
                }}
                onLoad={() => setLoadedUrl(artwork.url)}
                onError={() =>
                  setFailed((current) => [...current, artwork.url])
                }
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
                transition={{
                  duration: reduceMotion ? 0 : 0.45,
                  ease: "easeOut",
                }}
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
                  onError={() =>
                    setFailed((current) => [...current, artwork.url])
                  }
                />
              </motion.div>
            ) : null}
          </div>
          <motion.h1
            className={PHONE_TITLE_HERO_LOGO_BOX}
            initial={{ opacity: 0 }}
            animate={{ opacity: isRevealed ? 1 : 0 }}
            transition={{
              duration: reduceMotion ? 0.2 : HERO_MOTION.copyEnterS,
              ease: "easeOut",
            }}
          >
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
                style={{ filter: stageLogoFilter(logoShadow, 1) }}
              />
            ) : (
              <span className="text-cinematic-title line-clamp-2 text-[1.375rem] font-black uppercase leading-[0.9] text-white [font-stretch:78%]">
                {title}
              </span>
            )}
          </motion.h1>
        </div>
      </div>

      <motion.div
        className={PHONE_TITLE_HERO_COPY}
        initial="initial"
        animate={isRevealed ? "animate" : "initial"}
      >
        {facts ? (
          <motion.div variants={line(0)} className={PHONE_TITLE_HERO_FACTS}>
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
        <motion.div variants={line(2)} className={PHONE_TITLE_HERO_ACTIONS}>
          <span className={`flex ${PHONE_TITLE_HERO_PLAY} ${HERO_PRESS}`}>
            <Link
              to={playTo}
              onClick={handlePlay}
              aria-label={
                progress
                  ? `${playLabel}, ${t("hero.timeLeft").replace("{time}", progress.left)}`
                  : playLabel
              }
              className={`relative flex h-full w-full min-w-0 items-center justify-center gap-2 rounded-full px-6 text-[0.9375rem] font-bold ${HERO_PLAY} ${HERO_FOCUS}`}
            >
              <Play size={18} fill="currentColor" className="shrink-0" />
              {/* Under way, it names what it resumes (a series' episode, or
                  the verb) and how long is left, as the desktop's does. */}
              <span className="truncate">
                {progress ? shortPlayLabel : playLabel}
              </span>
              {progress ? (
                <>
                  <span
                    className={`${PLAY_TIME_LEFT} shrink-0 text-[0.84375rem] text-zinc-500`}
                  >
                    <span aria-hidden="true">·&nbsp; </span>
                    {t("hero.timeLeft").replace("{time}", progress.left)}
                  </span>
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-7 bottom-[7px] h-[2px] overflow-hidden rounded-full bg-zinc-950/[0.12]"
                  >
                    <span
                      className="block h-full rounded-full bg-zinc-950"
                      style={{ width: `${Math.max(3, progress.share * 100)}%` }}
                    />
                  </span>
                </>
              ) : null}
            </Link>
          </span>
          <div className={PHONE_TITLE_HERO_ROW}>
            {canStartOver ? (
              <span className={PHONE_TITLE_HERO_ACTION_SLOT}>
                <Link
                  to={`${playTo}${playTo.includes("?") ? "&" : "?"}start=0`}
                  aria-label={t("details.playFromBeginning")}
                  className={PHONE_TITLE_HERO_ACTION}
                >
                  <RotateCcw size={PHONE_TITLE_ACTION_ICON} strokeWidth={2} />
                  <span>{t("details.startOverShort")}</span>
                </Link>
              </span>
            ) : null}
            <span className={PHONE_TITLE_HERO_ACTION_SLOT}>
              <FavouriteButton
                item={item}
                iconSize={PHONE_TITLE_ACTION_ICON}
                showLabel
                shortLabel={t("myList.title")}
                className={PHONE_TITLE_HERO_ACTION}
              />
            </span>
            {/* The page's details own whether the title is watched; they
                put their button here. */}
            <span
              ref={onWatchedSlot}
              className={PHONE_TITLE_HERO_ACTION_SLOT}
            />
            {item.Type === "Movie" && isOfflineSupported() ? (
              <span className={PHONE_TITLE_HERO_ACTION_SLOT}>
                <DownloadButton
                  item={item}
                  iconSize={PHONE_TITLE_ACTION_ICON}
                  showLabel
                  className={PHONE_TITLE_HERO_ACTION}
                />
              </span>
            ) : null}
          </div>
        </motion.div>
      </motion.div>
    </section>
  );
}
