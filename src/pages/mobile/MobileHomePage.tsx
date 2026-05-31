import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Info, Play } from "lucide-react";
import { ButtonLink } from "../../components/Button";
import { ErrorMessage } from "../../components/ErrorMessage";
import { MobileLibraryTile } from "../../components/mobile/MobileLibraryTile";
import { MobileMediaRow } from "../../components/mobile/MobileMediaRow";
import { useLanguage } from "../../i18n/LanguageContext";
import { getLatestContinueWatchingItems } from "../../lib/continueWatching";
import { formatRuntime, getDisplayTitle } from "../../lib/format";
import {
  getBackdropImageUrl,
  getContinueWatchingItems,
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
import type { JellyfinItem, JellyfinLibrary } from "../../lib/types";

type HomeRowLabelKey = "home.continueWatching" | "home.latestMedia";

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

  useEffect(() => {
    setSeoMetadata({
      title: `${t("common.home")} · Seyirlik`,
      canonicalPath: "/home",
      robots: "noindex, nofollow",
    });
  }, [t]);

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
      const homeCurationPreferences = loadHomeCurationPreferences();

      setData({
        libraries: librariesResult.value,
        continueWatching:
          continueResult.status === "fulfilled"
            ? getLatestContinueWatchingItems(continueResult.value)
            : [],
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
  };

  const heroItem = getFeaturedItem([
    ...data.continueWatching,
    ...data.latestMedia,
  ]);
  const heroImageUrl = getHeroImage(heroItem);
  const heroTitle = heroItem
    ? getDisplayTitle(heroItem, mediaFormatLabels)
    : "Seyirlik";
  const heroDescription =
    heroItem?.Overview?.trim() || t("hero.fallbackDescription");
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
  const canPlay =
    heroItem?.Type === "Movie" ||
    heroItem?.Type === "Episode" ||
    heroItem?.MediaType === "Video";
  const detailsButtonVariant = canPlay ? "secondary" : "primary";
  const detailsButtonClass = canPlay
    ? "min-h-11 rounded-full px-5"
    : "min-h-11 rounded-full bg-white px-5 text-black hover:bg-white/90";

  let heroArtwork = null;

  if (heroImageUrl) {
    heroArtwork = (
      <img
        src={heroImageUrl}
        alt=""
        className="absolute inset-0 h-full w-full object-cover opacity-65"
      />
    );
  }

  let playAction = null;

  if (heroItem && canPlay) {
    playAction = (
      <ButtonLink
        to={`/watch/${heroItem.Id}`}
        className="min-h-11 rounded-full bg-white px-5 text-black hover:bg-white/90"
      >
        <Play size={16} fill="currentColor" />
        {t("common.play")}
      </ButtonLink>
    );
  }

  return (
    <div className="layout-no-offset min-h-screen pb-[calc(5.25rem+env(safe-area-inset-bottom))]">
      <section className="full-bleed relative h-[min(62svh,31rem)] min-h-[27rem] overflow-hidden bg-zinc-950">
        {heroArtwork}
        <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/38 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#050506] via-black/18 to-black/45" />
        <div className="relative flex h-full flex-col justify-end px-4 pb-8 pt-[calc(4.25rem+env(safe-area-inset-top))]">
          <p className="mb-3 text-xs font-black uppercase tracking-[0.22em] text-[var(--accent)]">
            {t("hero.featured")}
          </p>
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={heroTitle}
              className="cinematic-logo-shadow mb-3 max-h-[4.5rem] max-w-[78vw] object-contain object-left"
            />
          ) : (
            <h1 className="mb-2 max-w-[20rem] text-4xl font-black leading-[0.95] text-white">
              {heroTitle}
            </h1>
          )}
          {metadata.length > 0 ? (
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-white/68">
              {metadata.join(" · ")}
            </p>
          ) : null}
          <p className="line-clamp-2 max-w-[21rem] text-sm leading-6 text-white/66">
            {heroDescription}
          </p>
          {heroItem ? (
            <div className="mt-5 flex gap-2.5">
              {playAction}
              <ButtonLink
                to={getRouteForItem(heroItem)}
                variant={detailsButtonVariant}
                className={detailsButtonClass}
              >
                <Info size={16} />
                {t("common.details")}
              </ButtonLink>
            </div>
          ) : null}
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
