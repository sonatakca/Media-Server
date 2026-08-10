import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronLeft } from "lucide-react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { RainbowAnimation } from "../../components/animations/RainbowAnimation";
import { ErrorMessage } from "../../components/ErrorMessage";
import { LoadingSpinner } from "../../components/LoadingSpinner";
import { CustomVideoPlayer } from "../../components/player/CustomVideoPlayer";
import { usePlaybackQueue } from "../../hooks/usePlaybackQueue";
import { usePlaybackSource } from "../../hooks/usePlaybackSource";
import { useLanguage } from "../../i18n/LanguageContext";
import { getItem } from "../../lib/jellyfinApi";
import {
  setDefaultPageTitle,
  setLoadingPageTitle,
  setPageTitle,
} from "../../lib/pageTitle";
import {
  getMediaOwnerRouteFromNavigationState,
  getMediaOwnerRouteForItem,
  getWatchRouteForItem,
} from "../../lib/routes";
import { readPreloadedPlaybackItem } from "../../lib/playbackPreload";
import { setSeoMetadata } from "../../lib/seo";
import type { MediaItem } from "../../lib/types";
import { usePlaybackReporting } from "../player/usePlaybackReporting";
import {
  getInitialPlaybackSeconds,
  getPlayerLoadingBackdropUrl,
} from "../player/playerPageModel";

export function MobilePlayerPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const shouldReduceMotion = Boolean(useReducedMotion());
  const [item, setItem] = useState<MediaItem | null>(() =>
    itemId ? readPreloadedPlaybackItem(itemId) : null,
  );
  const [itemError, setItemError] = useState<string | null>(null);
  const playback = usePlaybackSource(itemId);
  const playbackQueue = usePlaybackQueue(item);

  useEffect(() => {
    let isMounted = true;

    async function loadItem() {
      if (!itemId) {
        setItemError(t("player.missingItemId"));
        return;
      }

      setItemError(null);
      const preloadedItem = readPreloadedPlaybackItem(itemId);
      setItem(preloadedItem);

      try {
        const loadedItem = await getItem(itemId);

        if (isMounted) {
          setItem(loadedItem);
        }
      } catch (error) {
        if (isMounted) {
          setItemError(
            error instanceof Error
              ? error.message
              : t("player.couldNotLoadItem"),
          );
        }
      }
    }

    void loadItem();

    return () => {
      isMounted = false;
    };
  }, [itemId, t]);

  useEffect(() => {
    const isPageLoading = !item || playback.isLoading;

    if (isPageLoading) {
      const loadingTitle =
        item?.SeriesName && item?.IndexNumber
          ? `${item.SeriesName} - ${item.Name}`
          : item?.Name;

      setSeoMetadata({
        title: loadingTitle ?? t("player.preparing"),
        canonicalPath: itemId ? `/watch/${itemId}` : "/watch",
        robots: "noindex, nofollow",
      });
      setLoadingPageTitle(loadingTitle);
      return;
    }

    const title =
      item.SeriesName && item.IndexNumber
        ? `${item.SeriesName} - ${item.Name}`
        : item.Name;

    setPageTitle(title, {
      canonicalPath: `/watch/${item.Id}`,
      robots: "noindex, nofollow",
    });

    return () => {
      setDefaultPageTitle(false);
    };
  }, [item, itemId, playback.isLoading, t]);

  const {
    handlePlaybackBeforeUnload,
    handlePlaybackProgress,
    handlePlaybackStarted,
    handlePlaybackStopped,
  } = usePlaybackReporting(playback.activeSource);

  const handlePlayNextUp = useCallback(
    (nextItem: MediaItem) => {
      navigate(getWatchRouteForItem(nextItem));
    },
    [navigate],
  );

  const loadingBackdropUrl = getPlayerLoadingBackdropUrl(item);
  const requestedMediaOwnerRoute = getMediaOwnerRouteFromNavigationState(
    location.state,
  );
  const mediaOwnerRoute = item
    ? (requestedMediaOwnerRoute ?? getMediaOwnerRouteForItem(item))
    : "/home";

  const isPreparingPlayback =
    !item || playback.isLoading || !playback.activeSource;

  if (itemError) {
    return (
      <main className="min-h-screen bg-black p-4 text-white">
        <Link
          to="/home"
          className="mb-4 inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
        >
          <ChevronLeft size={17} />
          {t("common.home")}
        </Link>
        <ErrorMessage
          title={t("player.playbackUnavailable")}
          message={itemError}
        />
      </main>
    );
  }

  if (!item || playback.isLoading || !playback.activeSource) {
    if (item && playback.error) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-black p-4 text-white">
          <div className="w-full max-w-2xl">
            <Link
              to={mediaOwnerRoute}
              replace
              className="mb-4 inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
            >
              <ChevronLeft size={17} />
              {t("common.details")}
            </Link>
            <ErrorMessage
              title={t("player.playbackUnavailable")}
              message={playback.error.message}
              details={playback.error.details}
              onRetry={playback.retry}
            />
          </div>
        </main>
      );
    }

    return (
      <main className="relative min-h-screen overflow-hidden bg-black text-white">
        {loadingBackdropUrl ? (
          <>
            <img
              src={loadingBackdropUrl}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="absolute inset-0 h-full w-full scale-[1.02] object-cover"
            />

            <div aria-hidden="true" className="absolute inset-0 bg-black/45" />

            <div
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-black/45"
            />
          </>
        ) : null}

        <div className="relative z-10 flex min-h-screen items-center justify-center">
          <LoadingSpinner label="" />
        </div>
      </main>
    );
  }

  const restartPlayback =
    searchParams.get("start") === "0" || searchParams.get("restart") === "1";
  const initialStartSeconds = getInitialPlaybackSeconds(item, restartPlayback);

  return (
    <>
      {/* <RainbowAnimation
        startDelay={1}
        fadeInDuration={2}
        height="min(30rem, 45vh)"
        glowTop="10"
      /> */}
      <CustomVideoPlayer
        item={item}
        source={playback.activeSource}
        playbackCandidates={playback.candidates}
        notice={playback.notice}
        error={playback.error}
        hasTranscodingFallback={playback.hasTranscodingFallback}
        onVideoFailure={playback.handleVideoFailure}
        onVideoRecovery={playback.handleVideoRecovery}
        onTryTranscodedPlayback={playback.tryTranscodedPlayback}
        onRetryPlayback={playback.retry}
        initialStartSeconds={initialStartSeconds}
        onPlaybackStarted={handlePlaybackStarted}
        onPlaybackProgress={handlePlaybackProgress}
        onPlaybackStopped={handlePlaybackStopped}
        onPlaybackBeforeUnload={handlePlaybackBeforeUnload}
        nextEpisode={
          item.Type === "Episode" ? (playbackQueue?.nextItem ?? null) : null
        }
        playbackQueue={playbackQueue}
        enableDefaultNextEpisodeCountdown={item.Type === "Episode"}
        onAutoPlayNextEpisode={handlePlayNextUp}
        onPlayQueueItem={handlePlayNextUp}
        backTo={mediaOwnerRoute}
      />
    </>
  );
}
