import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { RainbowAnimation } from "../../components/animations/RainbowAnimation";
import { ErrorMessage } from "../../components/ErrorMessage";
import { LoadingSpinner } from "../../components/LoadingSpinner";
import { CustomVideoPlayer } from "../../components/player/CustomVideoPlayer";
import { usePlaybackSource } from "../../hooks/usePlaybackSource";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  getItem,
  getNextEpisodeInSeason,
  reportPlaybackProgress,
  reportPlaybackStart,
  reportPlaybackStopped,
  reportPlaybackStoppedBeforeUnload,
  ticksFromSeconds,
} from "../../lib/jellyfinApi";
import {
  setDefaultPageTitle,
  setLoadingPageTitle,
  setPageTitle,
} from "../../lib/pageTitle";
import { getWatchRouteForItem } from "../../lib/routes";
import { setSeoMetadata } from "../../lib/seo";
import type { JellyfinItem } from "../../lib/types";

export function MobilePlayerPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [item, setItem] = useState<JellyfinItem | null>(null);
  const [nextEpisode, setNextEpisode] = useState<JellyfinItem | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const playback = usePlaybackSource(itemId);

  useEffect(() => {
    let isMounted = true;

    async function loadItem() {
      if (!itemId) {
        setItemError(t("player.missingItemId"));
        return;
      }

      setItemError(null);
      setItem(null);
      setNextEpisode(null);

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
    if (item?.Type !== "Episode") {
      setNextEpisode(null);
      return undefined;
    }

    let isMounted = true;

    setNextEpisode(null);

    const loadNextEpisode = async () => {
      try {
        const nextEpisodeDetails = await getNextEpisodeInSeason(item);

        if (isMounted) {
          setNextEpisode(nextEpisodeDetails);
        }
      } catch (error) {
        if (isMounted) {
          setNextEpisode(null);
        }

        console.warn(
          "[Seyirlik Playback] Could not load next episode fallback target",
          error,
        );
      }
    };

    void loadNextEpisode();

    return () => {
      isMounted = false;
    };
  }, [item]);

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

  const handleAutoPlayNextEpisode = useCallback(
    (episode: JellyfinItem) => {
      navigate(getWatchRouteForItem(episode));
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

  const restartPlayback =
    searchParams.get("start") === "0" || searchParams.get("restart") === "1";
  const savedPlaybackSeconds =
    typeof item.UserData?.PlaybackPositionTicks === "number"
      ? item.UserData.PlaybackPositionTicks / 10_000_000
      : 0;
  const initialStartSeconds = restartPlayback ? 0 : savedPlaybackSeconds;

  return (
    <>
      <RainbowAnimation
        startDelay={1}
        fadeInDuration={2}
        height="min(30rem, 45vh)"
        glowTop="10"
      />
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
        nextEpisode={nextEpisode}
        enableDefaultNextEpisodeCountdown={item.Type === "Episode"}
        onAutoPlayNextEpisode={handleAutoPlayNextEpisode}
      />
    </>
  );
}
