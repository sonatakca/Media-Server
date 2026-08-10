import { useCallback } from "react";
import {
  reportPlaybackProgress,
  reportPlaybackStart,
  reportPlaybackStopped,
  reportPlaybackStoppedBeforeUnload,
  ticksFromSeconds,
} from "../../lib/mediaApi";
import type { PlaybackSourceCandidate } from "../../lib/types";

export function usePlaybackReporting(
  activeSource: PlaybackSourceCandidate | null,
) {
  const handlePlaybackStarted = useCallback(
    (positionSeconds: number) => {
      if (!activeSource) {
        return;
      }

      void reportPlaybackStart(
        activeSource,
        ticksFromSeconds(positionSeconds),
      ).catch((error) => {
        console.warn(
          "[Seyirlik Playback] Could not report playback start",
          error,
        );
      });
    },
    [activeSource],
  );

  const handlePlaybackProgress = useCallback(
    (positionSeconds: number, isPaused: boolean) => {
      if (!activeSource) {
        return;
      }

      void reportPlaybackProgress(
        activeSource,
        ticksFromSeconds(positionSeconds),
        isPaused,
      ).catch((error) => {
        console.warn(
          "[Seyirlik Playback] Could not report playback progress",
          error,
        );
      });
    },
    [activeSource],
  );

  const handlePlaybackStopped = useCallback(
    (positionSeconds: number) => {
      if (!activeSource) {
        return;
      }

      void reportPlaybackStopped(
        activeSource,
        ticksFromSeconds(positionSeconds),
      ).catch((error) => {
        console.warn(
          "[Seyirlik Playback] Could not report playback stopped",
          error,
        );
      });
    },
    [activeSource],
  );

  const handlePlaybackBeforeUnload = useCallback(
    (positionSeconds: number) => {
      if (!activeSource) {
        return;
      }

      reportPlaybackStoppedBeforeUnload(
        activeSource,
        ticksFromSeconds(positionSeconds),
      );
    },
    [activeSource],
  );

  return {
    handlePlaybackBeforeUnload,
    handlePlaybackProgress,
    handlePlaybackStarted,
    handlePlaybackStopped,
  };
}
