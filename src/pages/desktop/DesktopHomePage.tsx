import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ErrorMessage } from "../../components/ErrorMessage";
import { HeroSection } from "../../components/HeroSection";
import { LibraryTile } from "../../components/LibraryTile";
import { MediaRow } from "../../components/MediaRow";
import { MotionReveal } from "../../components/MotionReveal";
import { HomeSkeleton } from "../../components/Skeletons";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  getAllMovieAndSeriesItems,
  getContinueWatchingItems,
  getLatestMediaItems,
  getUserViews,
} from "../../lib/jellyfinApi";
import {
  applyHomeCarouselCuration,
  buildHomeCarouselPool,
  filterLatestMediaItems,
  loadHomeCurationPreferences,
  type HomeCurationPreferences,
} from "../../lib/homeCuration";
import { getLatestContinueWatchingItems } from "../../lib/continueWatching";
import { getRouteForItem } from "../../lib/routes";
import type { JellyfinItem, JellyfinLibrary } from "../../lib/types";
import { AnimatedText } from "../../components/AnimatedText";
import { AnimatedWidth } from "../../components/AnimatedWidth";
import { ConfettiAnimation } from "../../components/animations/ConfettiAnimation";
import { setSeoMetadata } from "../../lib/seo";
import { useStandaloneWebApp } from "../../hooks/useStandaloneWebApp";
import {
  consumeLoginConfettiPending,
  markDailyHomeConfettiShown,
  shouldShowDailyHomeConfetti,
} from "../../lib/homeConfetti";

type HomeRowLabelKey = "home.continueWatching" | "home.latestMedia";

const HERO_ROTATION_INTERVAL_MS = 12000;

interface HomeData {
  libraries: JellyfinLibrary[];
  continueWatching: JellyfinItem[];
  latestMedia: JellyfinItem[];
  heroItems: JellyfinItem[];
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

export function DesktopHomePage() {
  const { t } = useLanguage();
  const isWebApp = useStandaloneWebApp();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowWarnings, setRowWarnings] = useState<RowWarning[]>([]);
  const [heroIndex, setHeroIndex] = useState(0);
  const [isHeroPaused, setIsHeroPaused] = useState(false);
  const [heroProgressResetKey, setHeroProgressResetKey] = useState(0);
  const [heroProgressStartedAtMs, setHeroProgressStartedAtMs] = useState(() =>
    Date.now(),
  );
  const [homeCurationPreferences, setHomeCurationPreferences] =
    useState<HomeCurationPreferences>(() => loadHomeCurationPreferences());
  const [isHeroReady, setIsHeroReady] = useState(false);
  const [shouldShowConfetti, setShouldShowConfetti] = useState(false);
  const hasEvaluatedConfetti = useRef(false);
  const featuredPool = useMemo(() => {
    const heroItems =
      data?.heroItems && data.heroItems.length > 0
        ? data.heroItems
        : (data?.latestMedia ?? []);

    return applyHomeCarouselCuration(
      buildHomeCarouselPool(heroItems),
      homeCurationPreferences,
    );
  }, [data?.heroItems, data?.latestMedia, homeCurationPreferences]);
  const selectedHeroIndex = heroIndex < featuredPool.length ? heroIndex : 0;
  const heroItem = featuredPool[selectedHeroIndex];

  useEffect(() => {
    setSeoMetadata({
      title: `${t("common.home")} · Seyirlik`,
      canonicalPath: "/home",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    if (!isHeroReady || hasEvaluatedConfetti.current) {
      return;
    }

    hasEvaluatedConfetti.current = true;

    if (consumeLoginConfettiPending()) {
      markDailyHomeConfettiShown();
      setShouldShowConfetti(true);
      return;
    }

    if (shouldShowDailyHomeConfetti()) {
      markDailyHomeConfettiShown();
      setShouldShowConfetti(true);
    }
  }, [isHeroReady]);

  useEffect(() => {
    let isMounted = true;

    async function loadHome() {
      setError(null);
      setRowWarnings([]);

      const [librariesResult, continueResult, latestResult, heroItemsResult] =
        await Promise.allSettled([
          getUserViews(),
          getContinueWatchingItems(),
          getLatestMediaItems(),
          getAllMovieAndSeriesItems(),
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
      const nextHomeCurationPreferences = loadHomeCurationPreferences();
      setHomeCurationPreferences(nextHomeCurationPreferences);

      const latestMedia =
        latestResult.status === "fulfilled"
          ? filterLatestMediaItems(
              latestResult.value,
              nextHomeCurationPreferences,
            )
          : [];
      const heroItems =
        heroItemsResult.status === "fulfilled" &&
        Array.isArray(heroItemsResult.value)
          ? heroItemsResult.value
          : latestMedia;

      setData({
        libraries: librariesResult.value,
        continueWatching:
          continueResult.status === "fulfilled"
            ? getLatestContinueWatchingItems(continueResult.value)
            : [],
        latestMedia,
        heroItems,
      });
    }

    void loadHome();

    return () => {
      isMounted = false;
    };
  }, [t]);

  useEffect(() => {
    setHeroIndex(0);
    setIsHeroPaused(false);
    setIsHeroReady(false);
    setHeroProgressStartedAtMs(Date.now());
    setHeroProgressResetKey((current) => current + 1);
  }, [featuredPool]);

  useEffect(() => {
    if (featuredPool.length <= 1 || isHeroPaused || !isHeroReady) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setHeroProgressStartedAtMs(Date.now());
      setHeroIndex((currentIndex) => (currentIndex + 1) % featuredPool.length);
    }, HERO_ROTATION_INTERVAL_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    featuredPool.length,
    heroProgressResetKey,
    isHeroPaused,
    isHeroReady,
    selectedHeroIndex,
  ]);

  const handleSelectHeroIndex = (index: number) => {
    setHeroProgressStartedAtMs(Date.now());
    setHeroIndex(index);
    setHeroProgressResetKey((current) => current + 1);
  };

  const handleToggleHeroPaused = () => {
    setIsHeroPaused((current) => !current);
  };

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
  };

  if (error) {
    return <ErrorMessage title={t("home.couldNotLoad")} message={error} />;
  }

  const debugSkeleton = false;

  if (!data || debugSkeleton) {
    return <HomeSkeleton />;
  }

  const showContinueWatchingRow = data.continueWatching.length > 0;

  return (
    <div
      className={[
        "layout-no-offset",
        isWebApp ? "pt-[calc(env(safe-area-inset-top)+0rem)]" : "",
      ].join(" ")}
    >
      {shouldShowConfetti ? (
        <ConfettiAnimation startDelay={0} pieceCount={200} />
      ) : null}

      <div className="min-h-[100svh] full-bleed ">
        <HeroSection
          item={heroItem}
          currentIndex={selectedHeroIndex}
          totalItems={featuredPool.length}
          durationMs={HERO_ROTATION_INTERVAL_MS}
          progressStartedAtMs={heroProgressStartedAtMs}
          progressResetKey={isHeroReady ? heroProgressResetKey : "hero-loading"}
          isPaused={isHeroPaused || !isHeroReady}
          onTogglePaused={handleToggleHeroPaused}
          showPauseButton={isHeroReady}
          onSelectIndex={handleSelectHeroIndex}
          onHeroReady={() => setIsHeroReady(true)}
        />
      </div>

      <div className="mx-auto w-full max-w-[1600px] px-4 sm:px-6 lg:px-8">
        {rowWarnings.length > 0 ? (
          <div className="mb-4 space-y-3">
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
          {showContinueWatchingRow ? (
            <motion.div
              key="continue-watching"
              className="relative z-10"
              exit={{ opacity: 0, y: -10, height: 0 }}
              transition={{ duration: 0.24 }}
            >
              <MediaRow
                title={t("home.continueWatching")}
                items={data.continueWatching}
                getItemTo={getRouteForItem}
                emptyMessage={t("home.nothingInProgress")}
                showRestartWatching
                onClearContinueWatching={handleClearContinueWatching}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <MediaRow
          title={t("home.latestMedia")}
          items={data.latestMedia}
          getItemTo={getRouteForItem}
        />

        <MotionReveal className="group/row relative py-6" direction="up">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-[var(--accent)]/82">
                <AnimatedWidth value={t("home.browse")}>
                  <AnimatedText value={t("home.browse")} />
                </AnimatedWidth>
              </p>

              <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">
                <AnimatedWidth value={t("home.libraries")}>
                  <AnimatedText value={t("home.libraries")} />
                </AnimatedWidth>
              </h2>
            </div>
          </div>
          {data.libraries.length > 0 ? (
            <div className="media-scroll -mx-4 flex snap-x gap-5 overflow-x-auto px-4 pb-5 pt-1 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
              {data.libraries.map((library) => (
                <LibraryTile key={library.Id} library={library} />
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-white/10 bg-[var(--surface)] p-5 text-sm text-white/[0.62]">
              <AnimatedWidth value={t("home.noLibraries")}>
                <AnimatedText value={t("home.noLibraries")} />
              </AnimatedWidth>
            </p>
          )}
        </MotionReveal>
      </div>
    </div>
  );
}
