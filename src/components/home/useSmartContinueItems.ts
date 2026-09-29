import { useEffect, useState } from "react";
import { getSmartContinueWatchingItems } from "../../lib/smartContinueWatching";
import type { MediaItem } from "../../lib/types";
import { WATCH_STATUS_CHANGED_EVENT } from "../../lib/watchedStatusActions";

/**
 * What the viewer is part-way through, kept current as it changes. Asked for
 * once per hero, not once per title: each title's copy asking again put a
 * page-loading bar on screen at every change.
 */
export function useSmartContinueItems(): MediaItem[] {
  const [items, setItems] = useState<MediaItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void getSmartContinueWatchingItems()
        .then((next) => {
          if (!cancelled) setItems(next);
        })
        .catch(() => undefined);
    load();
    window.addEventListener(WATCH_STATUS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(WATCH_STATUS_CHANGED_EVENT, load);
    };
  }, []);
  return items;
}
