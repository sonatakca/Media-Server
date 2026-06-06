import { useCallback, useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { CustomVideoPlayer } from "../../components/player/CustomVideoPlayer";
import { ErrorMessage } from "../../components/ErrorMessage";
import { LoadingSpinner } from "../../components/LoadingSpinner";
import { usePlaybackQueue } from "../../hooks/usePlaybackQueue";
import { usePlaybackSource } from "../../hooks/usePlaybackSource";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  getItem,
  reportPlaybackProgress,
  reportPlaybackStart,
  reportPlaybackStopped,
  reportPlaybackStoppedBeforeUnload,
  ticksFromSeconds,
} from "../../lib/jellyfinApi";
import type { JellyfinItem } from "../../lib/types";
import { getWatchRouteForItem } from "../../lib/routes";
import {
  setDefaultPageTitle,
  setLoadingPageTitle,
  setPageTitle,
} from "../../lib/pageTitle";
import { setSeoMetadata } from "../../lib/seo";
import { ConfettiAnimation } from "../../components/animations/ConfettiAnimation";
import { RainbowAnimation } from "../../components/animations/RainbowAnimation";
import { SparkleAnimation } from "../../components/animations/SparkleAnimation";

export function DesktopPlayerPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [item, setItem] = useState<JellyfinItem | null>(null);
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
      setItem(null);

      try {
        const itemDetails = await getItem(itemId);

        console.info("[Seyirlik Item] Full item details", itemDetails);
        console.info("[Seyirlik Item] Chapters", (itemDetails as any).Chapters);
        console.info("[Seyirlik Item] MediaSources", itemDetails.MediaSources);

        if (isMounted) {
          setItem(itemDetails);
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

  const handlePlaybackStarted = useCallback(
    (positionSeconds: number) => {
      const source = playback.activeSource;

      if (!source) {
        return;
      }

      void reportPlaybackStart(source, ticksFromSeconds(positionSeconds)).catch(
        (error) => {
          console.warn(
            "[Seyirlik Playback] Could not report playback start",
            error,
          );
        },
      );
    },
    [playback.activeSource],
  );

  const handlePlaybackProgress = useCallback(
    (positionSeconds: number, isPaused: boolean) => {
      const source = playback.activeSource;

      if (!source) {
        return;
      }

      void reportPlaybackProgress(
        source,
        ticksFromSeconds(positionSeconds),
        isPaused,
      ).catch((error) => {
        console.warn(
          "[Seyirlik Playback] Could not report playback progress",
          error,
        );
      });
    },
    [playback.activeSource],
  );

  const handlePlaybackStopped = useCallback(
    (positionSeconds: number) => {
      const source = playback.activeSource;

      if (!source) {
        return;
      }

      void reportPlaybackStopped(
        source,
        ticksFromSeconds(positionSeconds),
      ).catch((error) => {
        console.warn(
          "[Seyirlik Playback] Could not report playback stopped",
          error,
        );
      });
    },
    [playback.activeSource],
  );

  const handlePlaybackBeforeUnload = useCallback(
    (positionSeconds: number) => {
      const source = playback.activeSource;

      if (!source) {
        return;
      }

      reportPlaybackStoppedBeforeUnload(
        source,
        ticksFromSeconds(positionSeconds),
      );
    },
    [playback.activeSource],
  );

  const handlePlayNextUp = useCallback(
    (nextItem: JellyfinItem) => {
      navigate(getWatchRouteForItem(nextItem));
    },
    [navigate],
  );

  if (itemError) {
    return (
      <main className="min-h-screen bg-black p-4 text-white">
        <Link
          to="/home"
          className="mb-4 inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft size={17} />
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
              to={`/item/${item.Id}`}
              className="mb-4 inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
            >
              <ArrowLeft size={17} />
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
      <main className="min-h-screen bg-black text-white">
        <LoadingSpinner label={t("player.preparing")} />
      </main>
    );
  }

  const shouldStartFromBeginning =
    searchParams.get("start") === "0" || searchParams.get("restart") === "1";
  const savedPlaybackSeconds =
    typeof item.UserData?.PlaybackPositionTicks === "number"
      ? item.UserData.PlaybackPositionTicks / 10_000_000
      : 0;

  const initialStartSeconds = shouldStartFromBeginning
    ? 0
    : savedPlaybackSeconds;

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
      />
    </>
  );
}
