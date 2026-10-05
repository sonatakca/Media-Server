import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatRuntime } from "../../lib/format";
import {
  getItemDisplayMetadata,
  getItemLogoUrlById,
} from "../../lib/itemMetadataPreferences";
import {
  getBackdropImageUrl,
  getLogoImageUrl,
  getPrimaryImageUrl,
} from "../../lib/mediaApi";
import { getPlayTargetForItem } from "../../lib/playTarget";
import { getRouteForItem } from "../../lib/routes";
import type { MediaItem } from "../../lib/types";
import { FavouriteButton } from "../FavouriteButton";
import { TimedCarouselIndicators } from "../TimedCarouselIndicators";
import { heroPlayState } from "../home/HeroActions";

/**
 * The phone's home hero: one poster, held as a card in the middle of a room
 * lit by its own colours, and a timed row of dots under it. The card carries
 * the same copy as the desktop hero, in the phone's order: the title's logo,
 * its facts, and play beside My List. Tapping the card opens the title.
 *
 * Its loading state is built from the same frame (`PhoneHomeHeroSkeleton`),
 * so every placeholder is the size of, and where, the piece that replaces it.
 */

const ROTATION_INTERVAL_MS = 12000;
const SWIPE_DISTANCE_PX = 70;
const SWIPE_VELOCITY_PX_S = 450;
const EASE_OUT = [0.25, 1, 0.5, 1] as const;

/**
 * The card is sized by the screen's height as well as its width, so the card
 * and its dots stand in full above the tab bar on a small phone too: the
 * page's top inset, the dots and their gap, and the tab bar come off the
 * height, and a 2:3 card takes what is left.
 */
const CARD_WIDTH =
  "min(20.5rem, max(14rem, calc((100svh - 15.25rem - env(safe-area-inset-top) - env(safe-area-inset-bottom)) / 1.5)))";

/** The pill around the dots: the desktop hero's glass. */
const PILL =
  "rounded-full border border-white/[0.14] bg-black/60 p-1 shadow-[0_18px_60px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-2xl";

/**
 * The round button's glass. It stands on the card's dark foot rather than on
 * open artwork, so it is a lighter glass than the desktop's smoke, or it
 * would disappear into the black under it.
 */
const GLASS =
  "border border-white/[0.16] bg-white/[0.1] backdrop-blur-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_10px_24px_-10px_rgba(0,0,0,0.7)]";

const FOCUS =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050607]";

function getPosterUrl(item: MediaItem): string {
  if (item.Type === "Episode" && item.SeriesId && item.SeriesPrimaryImageTag) {
    return getPrimaryImageUrl(item.SeriesId, item.SeriesPrimaryImageTag, 900);
  }
  if (item.ImageTags?.Primary) {
    return getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 900);
  }
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    return getBackdropImageUrl(
      item.ParentBackdropItemId,
      item.ParentBackdropImageTags[0],
      1280,
    );
  }
  if (item.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(item.Id, item.BackdropImageTags[0], 1280);
  }
  return "";
}

/** The room and the column the card and its dots stand in. */
function PhoneHeroFrame({
  ambient,
  children,
}: {
  ambient?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="full-bleed relative overflow-hidden bg-zinc-950 px-4 pb-8 pt-[calc(4.75rem+env(safe-area-inset-top))]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_32%,rgba(82,82,91,0.28),transparent_46%),linear-gradient(180deg,#111113_0%,#070708_55%,#050506_100%)]" />
      {ambient}
      <div className="absolute inset-0 bg-gradient-to-b from-black/72 via-black/38 to-[#050506]" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#050506] via-[#050506]/20 to-black/30" />
      <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-[#050506] to-transparent" />
      <div className="relative mx-auto flex w-full flex-col items-center">
        {children}
      </div>
    </section>
  );
}

/** The card's edge and its fill, the same for the title and its placeholder. */
function CardShell({ children }: { children: ReactNode }) {
  return (
    <div className="cinematic-card-shadow relative aspect-[2/3] w-full rounded-[2rem] bg-gradient-to-t from-zinc-400/35 via-zinc-600/18 to-transparent p-px shadow-2xl">
      <div className="relative h-full w-full overflow-hidden rounded-[calc(2rem-1px)] bg-zinc-900">
        {children}
      </div>
    </div>
  );
}

/** The copy's column at the card's foot. */
const COPY =
  "absolute inset-x-0 bottom-0 z-10 flex flex-col items-center px-4 pb-4 text-center";
/** The logo's box: a fixed height, so the facts and actions never move. */
const LOGO_BOX =
  "mb-2.5 flex h-[clamp(3.5rem,11svh,5rem)] w-full items-end justify-center";
const FACTS =
  "mb-3.5 h-5 w-full truncate text-[0.8125rem] font-semibold leading-5 text-white/[0.82]";
const ACTIONS = "flex w-full items-center gap-2";
const ROUND =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full";

export function PhoneHomeHeroSkeleton() {
  return (
    <PhoneHeroFrame>
      <div style={{ width: CARD_WIDTH }}>
        <CardShell>
          <div className="shimmer absolute inset-0" />
          <div className="absolute inset-x-0 bottom-0 h-[58%] bg-gradient-to-t from-black from-[28%] via-black/75 to-transparent" />
          <div className={COPY}>
            <div className={LOGO_BOX}>
              <div className="shimmer h-[70%] w-2/3 rounded-lg bg-white/20" />
            </div>
            <div className={`${FACTS} flex justify-center`}>
              <div className="shimmer h-full w-3/5 rounded-md bg-white/20" />
            </div>
            <div className={ACTIONS}>
              <div className="shimmer h-11 flex-1 rounded-full bg-white/20" />
              <div className={`shimmer ${ROUND} bg-white/20`} />
            </div>
          </div>
        </CardShell>
      </div>
      {/* The pill as it stands with nine or more titles, its dots all shown. */}
      <div className={`mt-4 h-[2.875rem] w-[19.375rem] max-w-full ${PILL}`}>
        <div className="shimmer h-full w-full rounded-full" />
      </div>
    </PhoneHeroFrame>
  );
}

export function PhoneHomeHero({
  items,
  smartContinueItems,
}: {
  items: MediaItem[];
  /** What the viewer is part-way through, so play can resume it. */
  smartContinueItems: MediaItem[];
}) {
  const { language, t } = useLanguage();
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion() ?? false;
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [isPaused, setIsPaused] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [startedAtMs, setStartedAtMs] = useState(() => Date.now());
  const wasPausedBeforeDragRef = useRef(false);
  const itemsKey = items.map((item) => item.Id).join("|");

  // A new set of titles starts again from the first.
  useEffect(() => {
    setIndex(0);
    setStartedAtMs(Date.now());
    setResetKey((current) => current + 1);
  }, [itemsKey]);

  useEffect(() => {
    if (items.length <= 1 || isPaused) return undefined;
    const timeoutId = window.setTimeout(() => {
      setStartedAtMs(Date.now());
      setDirection(1);
      setIndex((current) => (current + 1) % items.length);
    }, ROTATION_INTERVAL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [items.length, resetKey, isPaused, index]);

  const goTo = useCallback(
    (next: number, towards: 1 | -1) => {
      if (items.length === 0) return;
      setDirection(towards);
      setStartedAtMs(Date.now());
      setIndex((next + items.length) % items.length);
      setResetKey((current) => current + 1);
    },
    [items.length],
  );

  if (items.length === 0) return <PhoneHomeHeroSkeleton />;

  const selected = index < items.length ? index : 0;
  const item = items[selected]!;
  const hasCarousel = items.length > 1;
  const posterUrl = getPosterUrl(item);
  const metadata = getItemDisplayMetadata(item, language);
  const title = metadata.title ?? item.Name;
  const fallbackLogoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 620)
    : item.ParentLogoItemId && item.ParentLogoImageTag
      ? getLogoImageUrl(item.ParentLogoItemId, item.ParentLogoImageTag, 620)
      : "";
  const logoUrl = getItemLogoUrlById(
    item.Type === "Episode"
      ? (item.SeriesId ?? item.ParentLogoItemId)
      : item.Id,
    language,
    fallbackLogoUrl,
  );
  const facts = [
    item.ProductionYear,
    formatRuntime(item.RunTimeTicks, {
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    item.Genres?.filter(Boolean).slice(0, 2).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
  const play = heroPlayState(item, smartContinueItems, t);
  const canPlay =
    item.Type === "Movie" ||
    item.Type === "Episode" ||
    item.Type === "Series" ||
    item.MediaType === "Video";

  const cardVariants = {
    initial: (towards: 1 | -1) => ({
      opacity: 0,
      x: reduceMotion ? 0 : towards * 100,
      scale: reduceMotion ? 1 : 0.965,
      rotateY: reduceMotion ? 0 : towards * -8,
      filter: reduceMotion ? "none" : "blur(14px)",
    }),
    animate: { opacity: 1, x: 0, scale: 1, rotateY: 0, filter: "blur(0px)" },
    exit: (towards: 1 | -1) => ({
      opacity: 0,
      x: reduceMotion ? 0 : towards * -100,
      scale: reduceMotion ? 1 : 0.965,
      rotateY: reduceMotion ? 0 : towards * 8,
      filter: reduceMotion ? "none" : "blur(12px)",
    }),
  };

  const ambient = (
    <AnimatePresence mode="sync">
      {posterUrl ? (
        <motion.div
          key={posterUrl}
          className="absolute -inset-16 overflow-hidden will-change-[opacity,transform]"
          initial={{ opacity: 0, scale: reduceMotion ? 1 : 1.025 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{
            opacity: 0,
            scale: reduceMotion ? 1 : 1.01,
            transition: {
              opacity: { duration: 0.6 },
              scale: { duration: 0.14 },
            },
          }}
          transition={{
            opacity: { duration: 0.9, delay: 0.2, ease: EASE_OUT },
            scale: { duration: 0.62, delay: 0.18, ease: EASE_OUT },
          }}
        >
          <img
            src={posterUrl}
            alt=""
            loading="eager"
            fetchPriority="high"
            decoding="async"
            className="h-full w-full scale-125 object-cover opacity-72 blur-3xl saturate-150"
          />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_36%,rgba(255,255,255,0.12),transparent_42%)] mix-blend-overlay" />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  return (
    <PhoneHeroFrame ambient={ambient}>
      <motion.div
        className="flex w-full flex-col items-center"
        initial={{ opacity: 0, y: reduceMotion ? 0 : 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: EASE_OUT }}
      >
        <AnimatePresence mode="popLayout" custom={direction} initial={false}>
          <motion.div
            key={item.Id}
            custom={direction}
            drag={hasCarousel ? "x" : false}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.18}
            onDragStart={() => {
              wasPausedBeforeDragRef.current = isPaused;
              setIsPaused(true);
            }}
            onDragEnd={(_event, info) => {
              if (hasCarousel) {
                if (
                  info.offset.x < -SWIPE_DISTANCE_PX ||
                  info.velocity.x < -SWIPE_VELOCITY_PX_S
                )
                  goTo(selected + 1, 1);
                else if (
                  info.offset.x > SWIPE_DISTANCE_PX ||
                  info.velocity.x > SWIPE_VELOCITY_PX_S
                )
                  goTo(selected - 1, -1);
              }
              setIsPaused(wasPausedBeforeDragRef.current);
            }}
            className="touch-pan-y"
            style={{ width: CARD_WIDTH }}
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: reduceMotion ? 0 : 0.42, ease: EASE_OUT }}
          >
            <div className="transition-transform duration-200 active:scale-[0.985]">
              <CardShell>
                {posterUrl ? (
                  <motion.img
                    src={posterUrl}
                    alt=""
                    loading="eager"
                    fetchPriority="high"
                    decoding="async"
                    draggable={false}
                    className="absolute inset-0 h-full w-full select-none object-cover"
                    initial={{
                      opacity: 0,
                      scale: reduceMotion ? 1 : 1.045,
                      filter: reduceMotion ? "none" : "blur(14px)",
                    }}
                    animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.55,
                      ease: EASE_OUT,
                    }}
                  />
                ) : null}

                {/* The foot sinks the poster's own lettering under the copy. */}
                <div className="absolute inset-0 bg-gradient-to-b from-black/5 via-black/0 to-black/60" />
                <div className="absolute inset-x-0 bottom-0 h-[58%] bg-gradient-to-t from-black from-[28%] via-black/75 to-transparent" />

                {/* The whole card opens the title; the copy lets taps through
                    to it, and only the actions stand above it. */}
                <Link
                  to={getRouteForItem(item)}
                  aria-label={title}
                  draggable={false}
                  className={`absolute inset-0 z-[1] rounded-[calc(2rem-1px)] ${FOCUS}`}
                />

                <div className={`pointer-events-none ${COPY}`}>
                  <div className={LOGO_BOX}>
                    {logoUrl ? (
                      <img
                        src={logoUrl}
                        alt=""
                        draggable={false}
                        className="cinematic-logo-shadow max-h-full max-w-[86%] select-none object-contain drop-shadow-[0_10px_22px_rgba(0,0,0,0.95)]"
                      />
                    ) : (
                      <p className="text-cinematic-title line-clamp-2 text-[2rem] font-black uppercase leading-[0.9] text-white drop-shadow-[0_10px_22px_rgba(0,0,0,0.95)]">
                        {title}
                      </p>
                    )}
                  </div>
                  <p className={FACTS}>{facts}</p>

                  {canPlay ? (
                    <div className={`pointer-events-auto ${ACTIONS}`}>
                      <a
                        href={`/watch/${play.playItem.Id}`}
                        aria-label={play.playLabel}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void getPlayTargetForItem(play.playItem).then(
                            (target) => navigate(target),
                          );
                        }}
                        className={`relative inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-white px-4 text-[0.9375rem] font-bold text-zinc-950 shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_14px_32px_-10px_rgba(0,0,0,0.65),0_2px_8px_rgba(0,0,0,0.25)] transition-transform duration-200 active:scale-[0.97] ${FOCUS}`}
                      >
                        <Play
                          size={18}
                          fill="currentColor"
                          className="shrink-0"
                        />
                        <span className="truncate">{play.shortPlayLabel}</span>
                        {play.progress ? (
                          <span
                            aria-hidden="true"
                            className="absolute inset-x-6 bottom-[6px] h-[2px] overflow-hidden rounded-full bg-zinc-950/[0.12]"
                          >
                            <span
                              className="block h-full rounded-full bg-zinc-950"
                              style={{
                                width: `${Math.max(3, play.progress.share * 100)}%`,
                              }}
                            />
                          </span>
                        ) : null}
                      </a>
                      <FavouriteButton
                        item={item}
                        iconSize={19}
                        className={`${ROUND} ${GLASS} text-white ${FOCUS}`}
                      />
                    </div>
                  ) : null}
                </div>
              </CardShell>
            </div>
          </motion.div>
        </AnimatePresence>

        {hasCarousel ? (
          <motion.div
            className={`mt-4 max-w-full overflow-hidden ${PILL}`}
            initial={{
              opacity: 0,
              y: reduceMotion ? 0 : 20,
              scale: reduceMotion ? 1 : 0.9,
            }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.1, ease: EASE_OUT }}
          >
            <TimedCarouselIndicators
              count={items.length}
              activeIndex={selected}
              durationMs={ROTATION_INTERVAL_MS}
              progressStartedAtMs={startedAtMs}
              onSelect={(next) => goTo(next, next >= selected ? 1 : -1)}
              isPaused={isPaused}
              progressResetKey={resetKey}
              onTogglePaused={() => setIsPaused((current) => !current)}
              showPauseButton
              maxVisibleDots={9}
              ariaLabel={t("hero.featured")}
            />
          </motion.div>
        ) : null}
      </motion.div>
    </PhoneHeroFrame>
  );
}
