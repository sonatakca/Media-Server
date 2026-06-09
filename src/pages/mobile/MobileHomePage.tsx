import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { ButtonLink } from "../../components/Button";
import { ErrorMessage } from "../../components/ErrorMessage";
import { MobileLibraryTile } from "../../components/mobile/MobileLibraryTile";
import { MobileMediaRow } from "../../components/mobile/MobileMediaRow";
import { TimedCarouselIndicators } from "../../components/TimedCarouselIndicators";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatRuntime, getDisplayTitle } from "../../lib/format";
import {
  getBackdropImageUrl,
  getLatestMediaItems,
  getLogoImageUrl,
  getPrimaryImageUrl,
  getUserViews,
} from "../../lib/jellyfinApi";
import {
  filterLatestMediaItems,
  loadHomeCurationPreferences,
} from "../../lib/homeCuration";
import { getRouteForItem } from "../../lib/routes";
import { setSeoMetadata } from "../../lib/seo";
import { getSmartContinueWatchingItems } from "../../lib/smartContinueWatching";
import type { JellyfinItem, JellyfinLibrary } from "../../lib/types";
import { WATCH_STATUS_CHANGED_EVENT } from "../../lib/watchedStatusActions";

type HomeRowLabelKey = "home.continueWatching" | "home.latestMedia";

const HERO_ROTATION_INTERVAL_MS = 12000;

const HERO_SWIPE_DISTANCE_THRESHOLD = 70;
const HERO_SWIPE_VELOCITY_THRESHOLD = 450;

interface MobileHomeData {
  libraries: JellyfinLibrary[];
  continueWatching: JellyfinItem[];
  latestMedia: JellyfinItem[];
}

interface RowWarning {
  labelKey: HomeRowLabelKey;
  message: string;
}

function getErrorMessage(
  result: PromiseRejectedResult,
  fallback: string,
): string {
  return result.reason instanceof Error ? result.reason.message : fallback;
}

function getHeroImage(item?: JellyfinItem): string {
  if (!item) {
    return "";
  }

  if (item.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(item.Id, item.BackdropImageTags[0], 1280);
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    return getBackdropImageUrl(
      item.ParentBackdropItemId,
      item.ParentBackdropImageTags[0],
      1280,
    );
  }

  if (item.ImageTags?.Primary) {
    return getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 700);
  }

  return "";
}

function getHeroPosterImage(item?: JellyfinItem): string {
  if (!item) {
    return "";
  }

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

function scoreHeroItem(item: JellyfinItem): number {
  let score = 0;

  if (item.BackdropImageTags?.[0] || item.ParentBackdropImageTags?.[0]) {
    score += 100;
  }

  if (item.ImageTags?.Logo || item.ParentLogoImageTag) {
    score += 30;
  }

  if (item.Overview?.trim()) {
    score += 10;
  }

  return score;
}

function getFeaturedItem(items: JellyfinItem[]): JellyfinItem | undefined {
  const seenIds = new Set<string>();

  return [...items]
    .filter((item) => {
      if (seenIds.has(item.Id)) {
        return false;
      }

      seenIds.add(item.Id);
      return true;
    })
    .sort((left, right) => scoreHeroItem(right) - scoreHeroItem(left))[0];
}

function getFeaturedItems(items: JellyfinItem[]): JellyfinItem[] {
  const seenIds = new Set<string>();

  return [...items]
    .filter((item) => {
      if (seenIds.has(item.Id)) {
        return false;
      }

      seenIds.add(item.Id);
      return true;
    })
    .sort((left, right) => scoreHeroItem(right) - scoreHeroItem(left));
}

function MobileHomeLoading() {
  return (
    <div className="layout-no-offset min-h-screen pb-24">
      <div className="shimmer h-[min(62svh,31rem)] min-h-[27rem] full-bleed" />
      <div className="space-y-8 px-4 pt-7">
        <div>
          <div className="shimmer h-6 w-40 rounded-full" />
          <div className="mt-4 flex gap-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div
                key={index}
                className="shimmer h-64 w-[8.8rem] shrink-0 rounded-xl"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MobileHomePage() {
  const { t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const wasHeroPausedBeforeDragRef = useRef(false);
  const mediaFormatLabels = useMemo(
    () => ({
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    [t],
  );
  const [data, setData] = useState<MobileHomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowWarnings, setRowWarnings] = useState<RowWarning[]>([]);
  const [heroIndex, setHeroIndex] = useState(0);
  const [heroDirection, setHeroDirection] = useState<1 | -1>(1);
  const [isHeroPaused, setIsHeroPaused] = useState(false);
  const [heroProgressResetKey, setHeroProgressResetKey] = useState(0);
  const [heroProgressStartedAtMs, setHeroProgressStartedAtMs] = useState(() =>
    Date.now(),
  );

  const heroItems = useMemo(() => {
    if (!data) {
      return [];
    }

    return getFeaturedItems([...data.continueWatching, ...data.latestMedia]);
  }, [data]);

  const refreshSmartContinueWatching = useCallback(async () => {
    const smartContinueItems = await getSmartContinueWatchingItems();

    setData((currentData) =>
      currentData
        ? {
            ...currentData,
            continueWatching: smartContinueItems,
          }
        : currentData,
    );
  }, []);

  useEffect(() => {
    setSeoMetadata({
      title: `${t("common.home")} · Seyirlik`,
      canonicalPath: "/home",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    setHeroIndex(0);
    setIsHeroPaused(false);
    setHeroProgressStartedAtMs(Date.now());
    setHeroProgressResetKey((current) => current + 1);
  }, [heroItems]);

  useEffect(() => {
    if (heroItems.length <= 1 || isHeroPaused) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setHeroProgressStartedAtMs(Date.now());
      setHeroDirection(1);
      setHeroIndex((currentIndex) => (currentIndex + 1) % heroItems.length);
    }, HERO_ROTATION_INTERVAL_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [heroItems.length, heroProgressResetKey, isHeroPaused, heroIndex]);

  useEffect(() => {
    let isMounted = true;

    async function loadHome() {
      setError(null);
      setRowWarnings([]);

      const [librariesResult, continueResult, latestResult] =
        await Promise.allSettled([
          getUserViews(),
          getSmartContinueWatchingItems(),
          getLatestMediaItems(),
        ]);

      if (!isMounted) {
        return;
      }

      if (librariesResult.status === "rejected") {
        setError(getErrorMessage(librariesResult, t("home.couldNotLoad")));
        setData(null);
        return;
      }

      const warnings: RowWarning[] = [];

      if (continueResult.status === "rejected") {
        warnings.push({
          labelKey: "home.continueWatching",
          message: getErrorMessage(continueResult, t("home.someDataFailed")),
        });
      }

      if (latestResult.status === "rejected") {
        warnings.push({
          labelKey: "home.latestMedia",
          message: getErrorMessage(latestResult, t("home.someDataFailed")),
        });
      }

      setRowWarnings(warnings);
      const homeCurationPreferences = loadHomeCurationPreferences();

      setData({
        libraries: librariesResult.value,
        continueWatching:
          continueResult.status === "fulfilled" ? continueResult.value : [],
        latestMedia:
          latestResult.status === "fulfilled"
            ? filterLatestMediaItems(
                latestResult.value,
                homeCurationPreferences,
              )
            : [],
      });
    }

    void loadHome();

    return () => {
      isMounted = false;
    };
  }, [t]);

  useEffect(() => {
    const handleWatchStatusChanged = () => {
      void refreshSmartContinueWatching();
    };

    window.addEventListener(
      WATCH_STATUS_CHANGED_EVENT,
      handleWatchStatusChanged,
    );

    return () => {
      window.removeEventListener(
        WATCH_STATUS_CHANGED_EVENT,
        handleWatchStatusChanged,
      );
    };
  }, [refreshSmartContinueWatching]);

  const goToHeroIndex = useCallback(
    (nextIndex: number, direction: 1 | -1) => {
      if (heroItems.length === 0) {
        return;
      }

      const wrappedIndex = (nextIndex + heroItems.length) % heroItems.length;

      setHeroDirection(direction);
      setHeroProgressStartedAtMs(Date.now());
      setHeroIndex(wrappedIndex);
      setHeroProgressResetKey((current) => current + 1);
    },
    [heroItems.length],
  );

  const handleSelectHeroIndex = (index: number) => {
    const direction = index >= heroIndex ? 1 : -1;
    goToHeroIndex(index, direction);
  };

  const handleToggleHeroPaused = () => {
    setIsHeroPaused((current) => !current);
  };

  const handleHeroDragEnd = (
    _event: MouseEvent | TouchEvent | PointerEvent,
    info: { offset: { x: number }; velocity: { x: number } },
  ) => {
    if (heroItems.length <= 1) {
      return;
    }

    const draggedLeft =
      info.offset.x < -HERO_SWIPE_DISTANCE_THRESHOLD ||
      info.velocity.x < -HERO_SWIPE_VELOCITY_THRESHOLD;

    const draggedRight =
      info.offset.x > HERO_SWIPE_DISTANCE_THRESHOLD ||
      info.velocity.x > HERO_SWIPE_VELOCITY_THRESHOLD;

    if (draggedLeft) {
      goToHeroIndex(heroIndex + 1, 1);
      return;
    }

    if (draggedRight) {
      goToHeroIndex(heroIndex - 1, -1);
    }
  };

  if (error) {
    return <ErrorMessage title={t("home.couldNotLoad")} message={error} />;
  }

  if (!data) {
    return <MobileHomeLoading />;
  }

  const handleClearContinueWatching = (clearedItem: JellyfinItem) => {
    setData((currentData) =>
      currentData
        ? {
            ...currentData,
            continueWatching: currentData.continueWatching.filter(
              (item) => item.Id !== clearedItem.Id,
            ),
          }
        : currentData,
    );
    void refreshSmartContinueWatching();
  };

  const selectedHeroIndex = heroIndex < heroItems.length ? heroIndex : 0;
  const heroItem =
    heroItems[selectedHeroIndex] ??
    getFeaturedItem([...data.continueWatching, ...data.latestMedia]);
  const showHeroCarousel = heroItems.length > 1;
  const heroImageUrl = getHeroImage(heroItem);
  const heroPosterUrl = getHeroPosterImage(heroItem);
  const heroTitle = heroItem
    ? getDisplayTitle(heroItem, mediaFormatLabels)
    : "Seyirlik";
  const logoUrl = heroItem?.ImageTags?.Logo
    ? getLogoImageUrl(heroItem.Id, heroItem.ImageTags.Logo, 620)
    : heroItem?.ParentLogoItemId && heroItem.ParentLogoImageTag
      ? getLogoImageUrl(
          heroItem.ParentLogoItemId,
          heroItem.ParentLogoImageTag,
          620,
        )
      : "";
  const mediaTypeLabel =
    heroItem?.Type === "Movie"
      ? t("common.movie")
      : heroItem?.Type === "Series"
        ? t("common.series")
        : heroItem?.Type;
  const metadata = [
    heroItem?.ProductionYear,
    formatRuntime(heroItem?.RunTimeTicks, mediaFormatLabels),
    mediaTypeLabel,
  ].filter(Boolean);
  const heroGenres = heroItem?.Genres?.slice(0, 3) ?? [];
  const canPlay =
    heroItem?.Type === "Movie" ||
    heroItem?.Type === "Episode" ||
    heroItem?.Type === "Series" ||
    heroItem?.MediaType === "Video";

  const heroThemeImageUrl = heroPosterUrl || heroImageUrl;
  const heroArtworkKey = heroThemeImageUrl || "mobile-hero-bg-fallback";
  const heroDetailsTo = heroItem ? getRouteForItem(heroItem) : "/home";

  const heroCardVariants = {
    initial: (direction: 1 | -1) => ({
      opacity: 0,
      x: shouldReduceMotion ? 0 : direction * 200,
      scale: shouldReduceMotion ? 1 : 0.965,
      rotateY: shouldReduceMotion ? 0 : direction * -8,
      filter: shouldReduceMotion ? "none" : "blur(14px)",
    }),
    animate: {
      opacity: 1,
      x: 0,
      scale: 1,
      rotateY: 0,
      filter: "blur(0px)",
    },
    exit: (direction: 1 | -1) => ({
      opacity: 0,
      x: shouldReduceMotion ? 0 : direction * -200,
      scale: shouldReduceMotion ? 1 : 0.965,
      rotateY: shouldReduceMotion ? 0 : direction * 8,
      filter: shouldReduceMotion ? "none" : "blur(12px)",
    }),
  };

  return (
    <div className="layout-no-offset min-h-screen pb-[calc(5.25rem+env(safe-area-inset-bottom))]">
      <section className="full-bleed relative min-h-[min(72svh,42rem)] overflow-hidden bg-zinc-950 px-4 pb-8 pt-[calc(4.75rem+env(safe-area-inset-top))]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_32%,rgba(82,82,91,0.28),transparent_46%),linear-gradient(180deg,#111113_0%,#070708_55%,#050506_100%)]" />
        <AnimatePresence mode="sync" initial={false}>
          {heroThemeImageUrl ? (
            <motion.div
              key={heroArtworkKey}
              className="absolute -inset-16 overflow-hidden will-change-[opacity,transform]"
              initial={{
                opacity: 0,
                scale: shouldReduceMotion ? 1 : 1.025,
              }}
              animate={{
                opacity: 1,
                scale: 1,
              }}
              exit={{
                opacity: 0,
                scale: shouldReduceMotion ? 1 : 1.01,
                transition: {
                  opacity: {
                    duration: shouldReduceMotion ? 0 : 0.6,
                    ease: [0.4, 0, 1, 1],
                  },
                  scale: {
                    duration: shouldReduceMotion ? 0 : 0.14,
                    ease: [0.4, 0, 1, 1],
                  },
                },
              }}
              transition={{
                opacity: {
                  duration: shouldReduceMotion ? 0 : 0.9,
                  delay: shouldReduceMotion ? 0 : 0.6,
                  ease: [0.25, 1, 0.5, 1],
                },
                scale: {
                  duration: shouldReduceMotion ? 0 : 0.62,
                  delay: shouldReduceMotion ? 0 : 0.18,
                  ease: [0.25, 1, 0.5, 1],
                },
              }}
            >
              <img
                src={heroThemeImageUrl}
                alt=""
                className="h-full w-full scale-125 object-cover opacity-72 blur-3xl saturate-150"
              />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_36%,rgba(255,255,255,0.12),transparent_42%)] mix-blend-overlay" />
            </motion.div>
          ) : null}
        </AnimatePresence>
        <div className="absolute inset-0 bg-gradient-to-b from-black/72 via-black/38 to-[#050506]" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#050506] via-[#050506]/20 to-black/30" />
        <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-[#050506] to-transparent" />

        <div className="relative mx-auto flex w-full max-w-[25rem] flex-col items-center">
          <AnimatePresence mode="wait" custom={heroDirection} initial={false}>
            <motion.div
              key={heroItem?.Id ?? "mobile-hero-card-fallback"}
              custom={heroDirection}
              drag={showHeroCarousel ? "x" : false}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.18}
              onDragStart={() => {
                wasHeroPausedBeforeDragRef.current = isHeroPaused;
                setIsHeroPaused(true);
              }}
              onDragEnd={(event, info) => {
                handleHeroDragEnd(event, info);
                setIsHeroPaused(wasHeroPausedBeforeDragRef.current);
              }}
              className="w-full max-w-[20.5rem] touch-pan-y"
              variants={heroCardVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{
                duration: shouldReduceMotion ? 0 : 0.42,
                ease: [0.25, 1, 0.5, 1],
              }}
            >
              <div className="cinematic-card-shadow relative aspect-[2/3] w-full rounded-[2rem] bg-gradient-to-t from-zinc-400/35 via-zinc-600/18 to-transparent p-px shadow-2xl transition-transform duration-200 active:scale-[0.985]">
                <Link
                  to={heroDetailsTo}
                  aria-label={heroTitle}
                  className="relative block h-full w-full overflow-hidden rounded-[calc(2rem-1px)] bg-zinc-900"
                >
                  <AnimatePresence mode="wait" initial={false}>
                    {heroPosterUrl || heroImageUrl ? (
                      <motion.img
                        key={heroPosterUrl || heroImageUrl}
                        src={heroPosterUrl || heroImageUrl}
                        alt={heroTitle}
                        className="absolute inset-0 h-full w-full object-cover"
                        initial={{
                          opacity: 0,
                          scale: shouldReduceMotion ? 1 : 1.045,
                          filter: shouldReduceMotion ? "none" : "blur(14px)",
                        }}
                        animate={{
                          opacity: 1,
                          scale: 1,
                          filter: "blur(0px)",
                        }}
                        exit={{
                          opacity: 0,
                          scale: shouldReduceMotion ? 1 : 0.985,
                          filter: shouldReduceMotion ? "none" : "blur(10px)",
                        }}
                        transition={{
                          duration: shouldReduceMotion ? 0 : 0.55,
                          ease: [0.25, 1, 0.5, 1],
                        }}
                      />
                    ) : null}
                  </AnimatePresence>

                  <div className="absolute inset-0 bg-gradient-to-b from-black/5 via-black/0 to-black/90" />
                  <div className="absolute inset-x-0 bottom-0 h-[33%] bg-gradient-to-t from-black via-black/50 to-transparent" />
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={heroItem?.Id ?? "mobile-hero-content-fallback"}
                      className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-center px-5 pb-5 text-center"
                      initial={{
                        opacity: 0,
                        y: shouldReduceMotion ? 0 : 22,
                        scale: shouldReduceMotion ? 1 : 0.985,
                        filter: shouldReduceMotion ? "none" : "blur(10px)",
                      }}
                      animate={{
                        opacity: 1,
                        y: 0,
                        scale: 1,
                        filter: "blur(0px)",
                      }}
                      exit={{
                        opacity: 0,
                        y: shouldReduceMotion ? 0 : -14,
                        scale: shouldReduceMotion ? 1 : 0.99,
                        filter: shouldReduceMotion ? "none" : "blur(8px)",
                      }}
                      transition={{
                        duration: shouldReduceMotion ? 0 : 0.42,
                        ease: [0.25, 1, 0.5, 1],
                      }}
                    >
                      {logoUrl ? (
                        <img
                          src={logoUrl}
                          alt={heroTitle}
                          className="cinematic-logo-shadow mb-4 max-h-20 max-w-[82%] object-contain drop-shadow-[0_10px_22px_rgba(0,0,0,0.95)]"
                        />
                      ) : (
                        <h1 className="cinematic-logo-shadow mb-4 line-clamp-2 text-3xl font-black leading-none text-white drop-shadow-[0_10px_22px_rgba(0,0,0,0.95)]">
                          {heroTitle}
                        </h1>
                      )}

                      {heroItem && canPlay ? (
                        <div className="flex w-full">
                          <ButtonLink
                            to={`/watch/${heroItem.Id}`}
                            className="min-h-11 w-full rounded-full bg-white px-5 text-black shadow-[0_12px_30px_rgba(0,0,0,0.65)] hover:bg-white/90"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Play size={20} fill="currentColor" />
                            {t("common.play")}
                          </ButtonLink>
                        </div>
                      ) : null}
                    </motion.div>
                  </AnimatePresence>
                </Link>
              </div>
            </motion.div>
          </AnimatePresence>

          <AnimatePresence>
            {showHeroCarousel ? (
              <motion.div
                key="mobile-hero-carousel-indicators"
                layout
                className="mt-4 max-w-full overflow-hidden rounded-full border border-white/25 bg-black/80 p-1 shadow-[0_24px_90px_rgba(0,0,0,0.78),0_0_0_1px_rgba(255,255,255,0.08)]"
                initial={{
                  opacity: 0,
                  y: shouldReduceMotion ? 0 : "140%",
                  scale: shouldReduceMotion ? 1 : 1.25,
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1.3,
                }}
                exit={{
                  opacity: 0,
                  y: shouldReduceMotion ? 0 : "222%",
                  scale: shouldReduceMotion ? 1 : 0.96,
                }}
                transition={{
                  duration: shouldReduceMotion ? 0 : 1,
                  delay: shouldReduceMotion ? 0 : 0.1,
                  ease: [0.25, 1, 0.5, 1],
                }}
              >
                <TimedCarouselIndicators
                  count={heroItems.length}
                  activeIndex={selectedHeroIndex}
                  durationMs={HERO_ROTATION_INTERVAL_MS}
                  progressStartedAtMs={heroProgressStartedAtMs}
                  onSelect={handleSelectHeroIndex}
                  isPaused={isHeroPaused}
                  progressResetKey={heroProgressResetKey}
                  onTogglePaused={handleToggleHeroPaused}
                  showPauseButton
                  maxVisibleDots={9}
                  ariaLabel="Featured carousel"
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </section>

      <div className="mx-auto w-full px-4 pt-2">
        {rowWarnings.length > 0 ? (
          <div className="space-y-3 py-3">
            {rowWarnings.map((warning) => (
              <ErrorMessage
                key={`${warning.labelKey}-${warning.message}`}
                title={t("home.someDataFailed")}
                message={`${t(warning.labelKey)}: ${warning.message}`}
              />
            ))}
          </div>
        ) : null}

        <AnimatePresence initial={false}>
          {data.continueWatching.length > 0 ? (
            <motion.div
              key="continue-watching"
              exit={{ opacity: 0, y: -8, height: 0 }}
              transition={{ duration: 0.22 }}
            >
              <MobileMediaRow
                title={t("home.continueWatching")}
                items={data.continueWatching}
                getItemTo={getRouteForItem}
                variant="landscape"
                emptyMessage={t("home.nothingInProgress")}
                showRestartWatching
                onClearContinueWatching={handleClearContinueWatching}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <MobileMediaRow
          title={t("home.latestMedia")}
          items={data.latestMedia}
          getItemTo={getRouteForItem}
          emptyMessage={t("home.noLatestMedia")}
        />

        <section className="relative py-5">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--accent)]/82">
            {t("home.browse")}
          </p>
          <h2 className="mt-1 text-xl font-black text-white">
            {t("home.libraries")}
          </h2>

          {data.libraries.length > 0 ? (
            <div className="media-scroll -mx-4 mt-4 flex snap-x gap-4 overflow-x-auto px-4 pb-4">
              {data.libraries.map((library) => (
                <MobileLibraryTile key={library.Id} library={library} />
              ))}
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-white/10 bg-[var(--surface)] p-5 text-sm text-white/[0.62]">
              {t("home.noLibraries")}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
