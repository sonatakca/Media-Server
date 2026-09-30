import { useEffect, useState } from "react";
import { getActiveTranscodingReasons } from "../../lib/mediaApi";
import { isCustomPlaybackCandidate } from "../../lib/playback-planner/customPlaybackApi";
import type { PlaybackSourceCandidate } from "../../lib/types";

/**
 * Why the server is transcoding the source on screen, polled while it is.
 *
 * Only a server-side transcode or HLS session has live reasons; anything else
 * answers an empty list without asking.
 */
export function useLiveTranscodingReasons(
  source: PlaybackSourceCandidate,
): [string[], (reasons: string[]) => void] {
  const [liveTranscodingReasons, setLiveTranscodingReasons] = useState<
    string[]
  >([]);

  const isCustomSource = isCustomPlaybackCandidate(source);

  useEffect(() => {
    let isCancelled = false;
    let intervalId: number | null = null;

    // A stored copy has no server session to ask about.
    const shouldFetchLiveReasons =
      !isCustomSource &&
      source.offline !== true &&
      (source.mode === "Transcoding" || source.isHls);

    if (!shouldFetchLiveReasons) {
      setLiveTranscodingReasons([]);
      return undefined;
    }

    const fetchLiveReasons = async () => {
      try {
        const reasons = await getActiveTranscodingReasons(
          source.itemId,
          source.playSessionId,
        );

        if (isCancelled) {
          return;
        }

        if (reasons === null) {
          // The session this poll was keyed to has been retired, which happens
          // on every audio, quality or page change. Asking again would just
          // produce a 404 every few seconds for a session that is meant to be
          // gone.
          if (intervalId !== null) {
            window.clearInterval(intervalId);
            intervalId = null;
          }
          setLiveTranscodingReasons([]);
          return;
        }

        setLiveTranscodingReasons((currentReasons) => {
          const nextReasons = Array.from(new Set(reasons.filter(Boolean)));

          if (
            currentReasons.length === nextReasons.length &&
            currentReasons.every(
              (reason, index) => reason === nextReasons[index],
            )
          ) {
            return currentReasons;
          }

          return nextReasons;
        });
      } catch (reasonError) {
        if (!isCancelled) {
          console.warn(
            "[Seyirlik Playback] Could not fetch live transcoding reasons",
            reasonError,
          );
        }
      }
    };

    void fetchLiveReasons();
    intervalId = window.setInterval(fetchLiveReasons, 3500);

    return () => {
      isCancelled = true;

      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [
    source.itemId,
    source.playSessionId,
    source.mode,
    source.isHls,
    source.offline,
    isCustomSource,
  ]);

  return [liveTranscodingReasons, setLiveTranscodingReasons];
}
