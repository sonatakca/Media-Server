import { describe, expect, it } from "vitest";
import { getMediaOwnerRouteForItem, getRouteForItem } from "./routes";
import type { JellyfinItem } from "./types";

describe("media routes", () => {
  it("routes movie details through library pages", () => {
    const movie: JellyfinItem = {
      Id: "movie-1",
      Name: "Movie",
      Type: "Movie",
    };

    expect(getRouteForItem(movie)).toBe("/library/movie-1");
    expect(getMediaOwnerRouteForItem(movie)).toBe("/library/movie-1");
  });

  it("routes episodes to playback but returns to the series page", () => {
    const episode: JellyfinItem = {
      Id: "episode-1",
      Name: "Episode",
      Type: "Episode",
      SeriesId: "series-1",
      SeasonId: "season-1",
    };

    expect(getRouteForItem(episode)).toBe("/watch/episode-1");
    expect(getMediaOwnerRouteForItem(episode)).toBe("/library/series-1");
  });

  it("routes local trailer playback back to its parent media page", () => {
    const trailer: JellyfinItem = {
      Id: "trailer-1",
      Name: "Trailer",
      Type: "Video",
      MediaType: "Video",
      ParentId: "movie-1",
    };

    expect(getRouteForItem(trailer)).toBe("/watch/trailer-1");
    expect(getMediaOwnerRouteForItem(trailer)).toBe("/library/movie-1");
  });
});
