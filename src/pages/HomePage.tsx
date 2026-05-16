import { useEffect, useMemo, useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { HeroSection } from "../components/HeroSection";
import { LibraryTile } from "../components/LibraryTile";
import { MediaRow } from "../components/MediaRow";
import { MotionReveal } from "../components/MotionReveal";
import { HomeSkeleton } from "../components/Skeletons";
import { useLanguage } from "../i18n/LanguageContext";
import {
  getContinueWatchingItems,
  getLatestMediaItems,
  getUserViews,
} from "../lib/jellyfinApi";
import { getRouteForItem } from "../lib/routes";
import type { JellyfinItem, JellyfinLibrary } from "../lib/types";
import { AnimatedText } from "../components/AnimatedText";
import { AnimatedWidth } from "../components/AnimatedWidth";
import { setPageTitle } from "../lib/pageTitle";
import { ConfettiAnimation } from "../components/animations/ConfettiAnimation";

type HomeRowLabelKey = "home.continueWatching" | "home.latestMedia";

const HERO_ROTATION_INTERVAL_MS = 12000;
const HERO_POOL_LIMIT = 8;

interface HomeData {
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

function hasBackdrop(item: JellyfinItem): boolean {
  return Boolean(
    item.BackdropImageTags?.[0] ||
    (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]),
  );
}

function hasPrimaryImage(item: JellyfinItem): boolean {
  return Boolean(item.ImageTags?.Primary);
}

function removeDuplicateItems(items: JellyfinItem[]): JellyfinItem[] {
  const seenItemIds = new Set<string>();

  return items.filter((item) => {
    if (seenItemIds.has(item.Id)) {
      return false;
    }

    seenItemIds.add(item.Id);
    return true;
  });
}

function scoreFeaturedItem(item: JellyfinItem): number {
  let score = 0;

  if (hasBackdrop(item)) {
    score += 100;
  } else if (hasPrimaryImage(item)) {
    score += 50;
  }

  if (item.ImageTags?.Logo) {
    score += 20;
  }

  if (item.Overview?.trim()) {
    score += 15;
  }

  if (item.Type === "Movie" || item.Type === "Series") {
    score += 10;
  }

  return score;
}

function buildFeaturedPool(items: JellyfinItem[]): JellyfinItem[] {
  return removeDuplicateItems(items)
    .map((item, index) => ({
      item,
      index,
      score: scoreFeaturedItem(item),
    }))
    .sort(
      (firstItem, secondItem) =>
        secondItem.score - firstItem.score ||
        firstItem.index - secondItem.index,
    )
    .slice(0, HERO_POOL_LIMIT)
    .map(({ item }) => item);
}

export function HomePage() {
  const { t } = useLanguage();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowWarnings, setRowWarnings] = useState<RowWarning[]>([]);
  const [heroIndex, setHeroIndex] = useState(0);
  const [isHeroPaused, setIsHeroPaused] = useState(false);
  const [heroProgressResetKey, setHeroProgressResetKey] = useState(0);
  const featuredPool = useMemo(
    () =>
      buildFeaturedPool([
        ...(data?.continueWatching ?? []),
        ...(data?.latestMedia ?? []),
      ]),
    [data?.continueWatching, data?.latestMedia],
  );
  const selectedHeroIndex = heroIndex < featuredPool.length ? heroIndex : 0;
  const heroItem = featuredPool[selectedHeroIndex];

  useEffect(() => {
    setPageTitle("Seyirlik");
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadHome() {
      setError(null);
      setRowWarnings([]);

      const [librariesResult, continueResult, latestResult] =
        await Promise.allSettled([
          getUserViews(),
          getContinueWatchingItems(),
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
      setData({
        libraries: librariesResult.value,
        continueWatching:
          continueResult.status === "fulfilled" ? continueResult.value : [],
        latestMedia:
          latestResult.status === "fulfilled" ? latestResult.value : [],
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
    setHeroProgressResetKey((current) => current + 1);
  }, [featuredPool]);

  useEffect(() => {
    if (featuredPool.length <= 1 || isHeroPaused) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setHeroIndex((currentIndex) => (currentIndex + 1) % featuredPool.length);
    }, HERO_ROTATION_INTERVAL_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    featuredPool.length,
    heroProgressResetKey,
    isHeroPaused,
    selectedHeroIndex,
  ]);

  const handleSelectHeroIndex = (index: number) => {
    setHeroIndex(index);
    setHeroProgressResetKey((current) => current + 1);
  };

  const handleToggleHeroPaused = () => {
    setIsHeroPaused((current) => !current);
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
    <div>
      <ConfettiAnimation startDelay={0} pieceCount={200} />
      <HeroSection
        item={heroItem}
        currentIndex={selectedHeroIndex}
        totalItems={featuredPool.length}
        durationMs={HERO_ROTATION_INTERVAL_MS}
        progressResetKey={heroProgressResetKey}
        isPaused={isHeroPaused}
        onTogglePaused={handleToggleHeroPaused}
        showPauseButton
        onSelectIndex={handleSelectHeroIndex}
      />

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

      {showContinueWatchingRow ? (
        <div className="relative z-10 -mt-14 sm:-mt-20">
          <MediaRow
            title={t("home.continueWatching")}
            items={data.continueWatching}
            getItemTo={getRouteForItem}
            emptyMessage={t("home.nothingInProgress")}
          />
        </div>
      ) : null}

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
  );
}
