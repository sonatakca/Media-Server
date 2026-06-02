import { describe, expect, it } from "vitest";
import {
  getCollectionPosterItems,
  shouldUseCollectionFallbackPoster,
} from "./collectionPoster";
import type { JellyfinItem } from "./types";

function item(id: string, overrides: Partial<JellyfinItem>): JellyfinItem {
  return {
    Id: id,
    Name: id,
    Type: "Movie",
    ...overrides,
  };
}

describe("collectionPoster", () => {
  it("uses fallback posters only for collections without primary images", () => {
    expect(
      shouldUseCollectionFallbackPoster(
        item("collection", { Type: "BoxSet", ImageTags: {} }),
      ),
    ).toBe(true);
    expect(
      shouldUseCollectionFallbackPoster(
        item("collection", {
          Type: "BoxSet",
          ImageTags: { Primary: "collection-poster" },
        }),
      ),
    ).toBe(false);
  });

  it("returns watch-ordered child posters and skips children without images", () => {
    const posterItems = getCollectionPosterItems([
      item("movie-3", {
        Name: "Example 3",
        ImageTags: { Primary: "poster-3" },
      }),
      item("movie-no-image", { Name: "Example 2" }),
      item("movie-1", {
        Name: "Example",
        ImageTags: { Primary: "poster-1" },
      }),
      item("movie-2", {
        Name: "Example 2",
        ImageTags: { Primary: "poster-2" },
      }),
    ]);

    expect(posterItems.map((posterItem) => posterItem.Id)).toEqual([
      "movie-1",
      "movie-2",
      "movie-3",
    ]);
  });
});
