import type { MediaItem } from "./types";

export interface LatestMediaGroups {
  movies: MediaItem[];
  shows: MediaItem[];
  books: MediaItem[];
}

export function groupLatestMediaItems(items: MediaItem[]): LatestMediaGroups {
  return {
    movies: items.filter((item) => item.Type === "Movie"),
    shows: items.filter((item) => item.Type === "Series"),
    books: items.filter((item) => item.Type === "Book"),
  };
}
