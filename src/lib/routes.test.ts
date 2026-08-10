import { describe, expect, it } from "vitest";
import {
  getMediaOwnerRouteFromNavigationState,
  getMediaOwnerRouteForItem,
  getReadRouteForItem,
  getRouteForItem,
  shouldOpenReaderForItem,
  shouldOpenPlaybackForItem,
} from "./routes";
import type { MediaItem } from "./types";

describe("media routes", () => {
  it("routes movie details through library pages", () => {
    const movie: MediaItem = {
      Id: "movie-1",
      Name: "Movie",
      Type: "Movie",
      MediaType: "Video",
    };

    expect(getRouteForItem(movie)).toBe("/movies/movie-1");
    expect(getMediaOwnerRouteForItem(movie)).toBe("/movies/movie-1");
    expect(shouldOpenPlaybackForItem(movie)).toBe(false);
  });

  it("routes episodes to playback but returns to the series page", () => {
    const episode: MediaItem = {
      Id: "episode-1",
      Name: "Episode",
      Type: "Episode",
      SeriesId: "series-1",
      SeasonId: "season-1",
    };

    expect(getRouteForItem(episode)).toBe("/watch/episode-1");
    expect(getMediaOwnerRouteForItem(episode)).toBe("/shows/series-1");
    expect(shouldOpenPlaybackForItem(episode)).toBe(true);
  });

  it("routes shows and seasons with an immediate show category hint", () => {
    const series: MediaItem = {
      Id: "series-1",
      Name: "Series",
      Type: "Series",
    };
    const season: MediaItem = {
      Id: "season-1",
      Name: "Season",
      Type: "Season",
      SeriesId: "series-1",
    };

    expect(getRouteForItem(series)).toBe("/shows/series-1");
    expect(getRouteForItem(season)).toBe("/shows/series-1/season/season-1");
  });

  it("routes local trailer playback back to its parent media page", () => {
    const trailer: MediaItem = {
      Id: "trailer-1",
      Name: "Trailer",
      Type: "Video",
      MediaType: "Video",
      ParentId: "movie-1",
    };

    expect(getRouteForItem(trailer)).toBe("/watch/trailer-1");
    expect(getMediaOwnerRouteForItem(trailer)).toBe("/library/movie-1");
    expect(shouldOpenPlaybackForItem(trailer)).toBe(true);
  });

  it("preserves an exact details route passed into player navigation", () => {
    expect(
      getMediaOwnerRouteFromNavigationState({
        mediaOwnerRoute: "/movies/movie-1",
      }),
    ).toBe("/movies/movie-1");
    expect(
      getMediaOwnerRouteFromNavigationState({
        mediaOwnerRoute: "/shows/show-1",
      }),
    ).toBe("/shows/show-1");
    expect(
      getMediaOwnerRouteFromNavigationState({
        mediaOwnerRoute: "https://example.com",
      }),
    ).toBeNull();
    expect(
      getMediaOwnerRouteFromNavigationState({
        mediaOwnerRoute: "//example.com",
      }),
    ).toBeNull();
  });

  it("routes books to the reader without treating them as watchable media", () => {
    const book: MediaItem = {
      Id: "book-1",
      Name: "Book",
      Type: "Book",
      MediaType: "Book",
      ParentId: "books-library",
    };

    expect(getReadRouteForItem(book)).toBe("/read/book-1");
    expect(getRouteForItem(book)).toBe("/read/book-1");
    expect(getMediaOwnerRouteForItem(book)).toBe("/library/books-library");
    expect(shouldOpenReaderForItem(book)).toBe(true);
    expect(shouldOpenPlaybackForItem(book)).toBe(false);
  });

  it("routes document-like book media to the reader", () => {
    const documentItem: MediaItem = {
      Id: "doc-1",
      Name: "Document",
      Type: "File",
      MediaType: "Document",
    };

    expect(getRouteForItem(documentItem)).toBe("/read/doc-1");
    expect(shouldOpenReaderForItem(documentItem)).toBe(true);
    expect(shouldOpenPlaybackForItem(documentItem)).toBe(false);
  });
});
