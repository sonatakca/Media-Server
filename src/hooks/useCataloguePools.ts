import { useEffect, useState } from "react";
import {
  getAllBookItems,
  getAllMovieItems,
  getAllSeriesItems,
} from "../lib/mediaApi";
import type { MediaItem } from "../lib/types";

export interface CataloguePools {
  movies: MediaItem[];
  series: MediaItem[];
  books: MediaItem[];
  /** False until the catalogue has arrived, so a caller can keep its fallback. */
  loaded: boolean;
}

const EMPTY_POOLS: CataloguePools = {
  movies: [],
  series: [],
  books: [],
  loaded: false,
};

/**
 * Every title, by kind, fetched after the first paint.
 *
 * The home rows draw from these rather than from the server's forty-item
 * Latest page: a hand-placed order has to be able to bring the ninth-oldest
 * film to the front of the row, and it cannot do that if the row only ever
 * sees the forty newest.
 *
 * Deliberately not awaited by the page's first render. The critical queries —
 * continue watching, the Latest page, favourites — are small and paint the
 * useful screen; this is the slow one, and holding the home page behind it
 * would trade a real regression for a refinement.
 */
export function useCataloguePools(): CataloguePools {
  const [pools, setPools] = useState<CataloguePools>(EMPTY_POOLS);

  useEffect(() => {
    let isMounted = true;

    void Promise.all([
      getAllMovieItems().catch(() => [] as MediaItem[]),
      getAllSeriesItems().catch(() => [] as MediaItem[]),
      getAllBookItems().catch(() => [] as MediaItem[]),
    ]).then(([movies, series, books]) => {
      if (!isMounted) return;
      // `loaded` is set even when every request failed: the fallback is the
      // Latest page, and retrying it forever would not make the catalogue
      // appear.
      setPools({ movies, series, books, loaded: true });
    });

    return () => {
      isMounted = false;
    };
  }, []);

  return pools;
}
