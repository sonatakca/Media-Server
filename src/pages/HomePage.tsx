import { useEffect, useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { HeroSection } from "../components/HeroSection";
import { LibraryTile } from "../components/LibraryTile";
import { MediaRow } from "../components/MediaRow";
import { MotionReveal } from "../components/MotionReveal";
import { HomeSkeleton } from "../components/Skeletons";
import { useLanguage } from "../i18n/LanguageContext";
import { getContinueWatchingItems, getLatestMediaItems, getUserViews } from "../lib/jellyfinApi";
import { getRouteForItem } from "../lib/routes";
import type { JellyfinItem, JellyfinLibrary } from "../lib/types";
import { AnimatedText } from "../components/AnimatedText";
import { AnimatedWidth } from "../components/AnimatedWidth";

type HomeRowLabelKey = "home.continueWatching" | "home.latestMedia";

interface HomeData {
  libraries: JellyfinLibrary[];
  continueWatching: JellyfinItem[];
  latestMedia: JellyfinItem[];
}

interface RowWarning {
  labelKey: HomeRowLabelKey;
  message: string;
}

function getErrorMessage(result: PromiseRejectedResult, fallback: string): string {
  return result.reason instanceof Error ? result.reason.message : fallback;
}

function hasBackdrop(item: JellyfinItem): boolean {
  return Boolean(item.BackdropImageTags?.[0] || (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]));
}

function hasPrimaryImage(item: JellyfinItem): boolean {
  return Boolean(item.ImageTags?.Primary);
}

function pickFeaturedItem(items: JellyfinItem[]): JellyfinItem | undefined {
  return items.find(hasBackdrop) ?? items.find(hasPrimaryImage) ?? items[0];
}

export function HomePage() {
  const { t } = useLanguage();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowWarnings, setRowWarnings] = useState<RowWarning[]>([]);

  useEffect(() => {
    let isMounted = true;

    async function loadHome() {
      setError(null);
      setRowWarnings([]);

      const [librariesResult, continueResult, latestResult] = await Promise.allSettled([
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
        warnings.push({ labelKey: "home.continueWatching", message: getErrorMessage(continueResult, t("home.someDataFailed")) });
      }

      if (latestResult.status === "rejected") {
        warnings.push({ labelKey: "home.latestMedia", message: getErrorMessage(latestResult, t("home.someDataFailed")) });
      }

      setRowWarnings(warnings);
      setData({
        libraries: librariesResult.value,
        continueWatching: continueResult.status === "fulfilled" ? continueResult.value : [],
        latestMedia: latestResult.status === "fulfilled" ? latestResult.value : [],
      });
    }

    void loadHome();

    return () => {
      isMounted = false;
    };
  }, [t]);

  if (error) {
    return <ErrorMessage title={t("home.couldNotLoad")} message={error} />;
  }

  if (!data) {
    return <HomeSkeleton />;
  }

  const featuredPool =
    data.continueWatching.length === 1 ? data.continueWatching : [...data.continueWatching, ...data.latestMedia];
  const heroItem = pickFeaturedItem(featuredPool);
  const showContinueWatchingRow = data.continueWatching.length > 0;

  return (
    <div>
      <HeroSection item={heroItem} />

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

      <MediaRow title={t("home.latestMedia")} items={data.latestMedia} getItemTo={getRouteForItem} />

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
