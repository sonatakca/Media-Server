import { describe, expect, it, vi } from "vitest";
import {
  buildSmartContinueWatchingItems,
  isSmartContinueCompleted,
} from "./smartContinueWatching";
import type { JellyfinItem } from "./types";

function item(id: string, values: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: id,
    Name: id,
    Type: "Episode",
    ...values,
  };
}

function episode(
  id: string,
  season: number,
  episodeNumber: number,
  values: Partial<JellyfinItem> = {},
): JellyfinItem {
  return item(id, {
    Type: "Episode",
    SeriesId: "series-1",
    ParentIndexNumber: season,
    IndexNumber: episodeNumber,
    RunTimeTicks: 100,
    ...values,
  });
}

const emptyDependencies = {
  getAllSeriesEpisodes: vi.fn(),
  getAllMovieItems: vi.fn(async () => []),
  getAllBoxSetItems: vi.fn(async () => []),
  getBoxSetItems: vi.fn(async () => []),
};

describe("Smart Continue Watching", () => {
  it("treats played items and 90% progress as completed", () => {
    expect(
      isSmartContinueCompleted(
        item("played", {
          UserData: { Played: true },
        }),
      ),
    ).toBe(true);

    expect(
      isSmartContinueCompleted(
        item("ninety-percent", {
          RunTimeTicks: 100,
          UserData: { PlaybackPositionTicks: 90 },
        }),
      ),
    ).toBe(true);

    expect(
      isSmartContinueCompleted(
        item("unfinished", {
          RunTimeTicks: 100,
          UserData: { PlaybackPositionTicks: 89 },
        }),
      ),
    ).toBe(false);
  });

  it("replaces stale old episode resumes with the next episode after the latest completed episode", async () => {
    const dependencies = {
      ...emptyDependencies,
      getAllSeriesEpisodes: vi.fn(async () => [
        episode("s1e1", 1, 1, { UserData: { Played: true } }),
        episode("s1e2", 1, 2, { UserData: { Played: true } }),
        episode("s2e1", 2, 1, {
          UserData: { LastPlayedDate: "2026-01-10T10:00:00Z" },
        }),
      ]),
    };

    const result = await buildSmartContinueWatchingItems(
      [
        episode("s1e1", 1, 1, {
          UserData: {
            PlaybackPositionTicks: 94,
            LastPlayedDate: "2025-12-01T10:00:00Z",
          },
        }),
      ],
      { dependencies },
    );

    expect(result.map((candidate) => candidate.Id)).toEqual(["s2e1"]);
  });

  it("drops the show when every episode after the latest completed episode is also completed", async () => {
    const dependencies = {
      ...emptyDependencies,
      getAllSeriesEpisodes: vi.fn(async () => [
        episode("s1e1", 1, 1, { UserData: { Played: true } }),
        episode("s1e2", 1, 2, { UserData: { Played: true } }),
      ]),
    };

    const result = await buildSmartContinueWatchingItems(
      [
        episode("s1e1", 1, 1, {
          UserData: { PlaybackPositionTicks: 94 },
        }),
      ],
      { dependencies },
    );

    expect(result).toEqual([]);
  });

  it("keeps genuinely unfinished movie resumes without guessing sequels from titles", async () => {
    const result = await buildSmartContinueWatchingItems(
      [
        item("movie-1", {
          Type: "Movie",
          Name: "Batman Returns",
          RunTimeTicks: 100,
          UserData: { PlaybackPositionTicks: 50 },
        }),
      ],
      { dependencies: emptyDependencies },
    );

    expect(result.map((candidate) => candidate.Id)).toEqual(["movie-1"]);
    expect(emptyDependencies.getAllMovieItems).not.toHaveBeenCalled();
  });

  it("promotes the next movie only when TMDb collection metadata links the movies", async () => {
    const completedMovie = item("movie-1", {
      Type: "Movie",
      Name: "Collection Part 1",
      ProductionYear: 2020,
      ProviderIds: { TmdbCollection: "collection-1" },
      RunTimeTicks: 100,
      UserData: { PlaybackPositionTicks: 95 },
    });
    const nextMovie = item("movie-2", {
      Type: "Movie",
      Name: "Collection Part 2",
      ProductionYear: 2021,
      ProviderIds: { TmdbCollection: "collection-1" },
      UserData: { Played: false },
    });
    const dependencies = {
      ...emptyDependencies,
      getAllMovieItems: vi.fn(async () => [completedMovie, nextMovie]),
    };

    const result = await buildSmartContinueWatchingItems([completedMovie], {
      dependencies,
    });

    expect(result.map((candidate) => candidate.Id)).toEqual(["movie-2"]);
  });
});
