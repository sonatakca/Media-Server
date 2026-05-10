import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { CustomVideoPlayer } from "../components/player/CustomVideoPlayer";
import { ErrorMessage } from "../components/ErrorMessage";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { usePlaybackSource } from "../hooks/usePlaybackSource";
import { useLanguage } from "../i18n/LanguageContext";
import {
  getItem,
  reportPlaybackProgress,
  reportPlaybackStart,
  reportPlaybackStopped,
  ticksFromSeconds,
} from "../lib/jellyfinApi";
import type { JellyfinItem } from "../lib/types";

export function PlayerPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const { t } = useLanguage();
  const [item, setItem] = useState<JellyfinItem | null>(null);
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
          setItemError(error instanceof Error ? error.message : t("player.couldNotLoadItem"));
        }
      }
    }

    void loadItem();

    return () => {
      isMounted = false;
    };
  }, [itemId, t]);

  const handlePlaybackStarted = useCallback(
    (positionSeconds: number) => {
      if (!itemId) {
        return;
      }

      void reportPlaybackStart(itemId, ticksFromSeconds(positionSeconds)).catch(() => undefined);
    },
    [itemId],
  );

  const handlePlaybackProgress = useCallback(
    (positionSeconds: number, isPaused: boolean) => {
      if (!itemId) {
        return;
      }

      void reportPlaybackProgress(itemId, ticksFromSeconds(positionSeconds), isPaused).catch(() => undefined);
    },
    [itemId],
  );

  const handlePlaybackStopped = useCallback(
    (positionSeconds: number) => {
      if (!itemId) {
        return;
      }

      void reportPlaybackStopped(itemId, ticksFromSeconds(positionSeconds)).catch(() => undefined);
    },
    [itemId],
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
        <ErrorMessage title={t("player.playbackUnavailable")} message={itemError} />
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

  return (
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
      onPlaybackStarted={handlePlaybackStarted}
      onPlaybackProgress={handlePlaybackProgress}
      onPlaybackStopped={handlePlaybackStopped}
    />
  );
}
