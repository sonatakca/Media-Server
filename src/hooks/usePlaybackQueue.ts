import { useEffect, useState } from "react";
import { getPlaybackQueue, type PlaybackQueue } from "../lib/playbackQueue";
import type { JellyfinItem } from "../lib/types";

export function usePlaybackQueue(
  item: JellyfinItem | null,
): PlaybackQueue | null {
  const [playbackQueue, setPlaybackQueue] = useState<PlaybackQueue | null>(
    null,
  );

  useEffect(() => {
    if (!item) {
      setPlaybackQueue(null);
      return undefined;
    }

    let isMounted = true;

    setPlaybackQueue(null);

    const loadPlaybackQueue = async () => {
      try {
        const queue = await getPlaybackQueue(item);

        if (isMounted) {
          setPlaybackQueue(queue);
        }
      } catch (error) {
        if (isMounted) {
          setPlaybackQueue(null);
        }

        console.warn(
          "[Seyirlik Playback] Could not load playback queue",
          error,
        );
      }
    };

    void loadPlaybackQueue();

    return () => {
      isMounted = false;
    };
  }, [item]);

  return playbackQueue;
}
