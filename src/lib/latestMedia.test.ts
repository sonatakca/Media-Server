import { describe, expect, it } from "vitest";
import { groupLatestMediaItems } from "./latestMedia";
import type { MediaItem } from "./types";

describe("groupLatestMediaItems", () => {
  it("separates the latest movies, shows, and books", () => {
    const items: MediaItem[] = [
      { Id: "movie", Name: "Movie", Type: "Movie" },
      { Id: "show", Name: "Show", Type: "Series" },
      { Id: "book", Name: "Book", Type: "Book" },
      { Id: "episode", Name: "Episode", Type: "Episode" },
    ];

    expect(groupLatestMediaItems(items)).toEqual({
      movies: [items[0]],
      shows: [items[1]],
      books: [items[2]],
    });
  });
});
