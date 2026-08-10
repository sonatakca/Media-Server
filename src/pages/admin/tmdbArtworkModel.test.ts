import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../lib/types";
import {
  ARTWORK_KINDS,
  TARGET_FILE_BY_KIND,
  createTmdbResultFromProvider,
  getCurrentArtworkPreviewUrl,
  getEpisodeMetadataKey,
  getMediaTypeForItem,
  getSearchableText,
  getStatusClasses,
  getTmdbIdFromItem,
} from "./tmdbArtworkModel";

vi.mock("../../lib/jellyfinApi", () => ({
  getBackdropImageUrl: vi.fn(),
  getLogoImageUrl: vi.fn(),
  getPrimaryImageUrl: vi.fn(),
  getThumbImageUrl: vi.fn(),
}));

describe("tmdbArtworkModel", () => {
  it("preserves artwork kinds, target names, and provider-id parsing", () => {
    expect(ARTWORK_KINDS).toEqual(["poster", "backdrop", "logo"]);
    expect(TARGET_FILE_BY_KIND).toEqual({
      poster: "folder.jpg",
      backdrop: "backdrop.jpg",
      landscape: "landscape.jpg",
      logo: "logo.png",
    });
    expect(
      getTmdbIdFromItem({
        Id: "movie",
        Name: "Movie",
        ProviderIds: { tmdb: "42" },
      } as MediaItem),
    ).toBe(42);
    expect(
      getTmdbIdFromItem({
        Id: "movie",
        Name: "Movie",
        ProviderIds: { Tmdb: "0" },
      } as MediaItem),
    ).toBeNull();
  });

  it("preserves provider-result mapping and media-type choice", () => {
    const item = {
      Id: "series",
      Name: "Series",
      Type: "Series",
      ProviderIds: { TMDB: "7" },
      ProductionYear: 2026,
    } as MediaItem;
    expect(getMediaTypeForItem(item)).toBe("tv");
    expect(createTmdbResultFromProvider(item)).toMatchObject({
      id: 7,
      mediaType: "tv",
      title: "Series",
      year: 2026,
      posterPath: null,
    });
  });

  it("preserves preview cache-busting and utility edge cases", () => {
    expect(getCurrentArtworkPreviewUrl("/image?a=1", 3)).toBe(
      "/image?a=1&preview=3",
    );
    expect(getCurrentArtworkPreviewUrl(null, 3)).toBeNull();
    expect(getEpisodeMetadataKey(1, 2)).toBe("1:2");
    expect(getEpisodeMetadataKey(undefined, 2)).toBeNull();
    expect(getStatusClasses("error")).toContain("red");
    expect(
      getSearchableText({
        Id: "movie",
        Name: "The Movie",
        Genres: ["Science Fiction"],
      } as MediaItem),
    ).toBe("the movie science fiction");
  });
});
