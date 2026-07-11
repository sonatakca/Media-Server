import type { JellyfinItem } from "./types";

export interface LatestMediaGroups {
  movies: JellyfinItem[];
  shows: JellyfinItem[];
  books: JellyfinItem[];
}

export function groupLatestMediaItems(
  items: JellyfinItem[],
): LatestMediaGroups {
  return {
    movies: items.filter((item) => item.Type === "Movie"),
    shows: items.filter((item) => item.Type === "Series"),
    books: items.filter((item) => item.Type === "Book"),
  };
}
