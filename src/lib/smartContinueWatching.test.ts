import { describe, expect, it } from "vitest";
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

  it("prioritizes NextUp episodes and drops stale completed episodes from the resume feed", () => {
    const staleResumeItem = episode("s1e1", 1, 1, {
      UserData: {
        PlaybackPositionTicks: 94,
        LastPlayedDate: "2025-12-01T10:00:00Z",
      },
    });
    const nextUpItem = episode("s1e2", 1, 2, {
      UserData: {
        PlaybackPositionTicks: 0,
        LastPlayedDate: "2026-01-10T10:00:00Z",
      },
    });

    const result = buildSmartContinueWatchingItems(
      [staleResumeItem],
      [nextUpItem],
    );

    expect(result.map((candidate) => candidate.Id)).toEqual(["s1e2"]);
  });

  it("filters out completely unstarted S1E1 pilot episodes", () => {
    const unstartedPilot = episode("s1e1", 1, 1, {
      UserData: { PlaybackPositionTicks: 0 },
    });

    const startedPilot = episode("s1e1-started", 1, 1, {
      SeriesId: "series-2",
      UserData: { PlaybackPositionTicks: 15 },
    });

    const result = buildSmartContinueWatchingItems(
      [],
      [unstartedPilot, startedPilot],
    );

    expect(result.map((candidate) => candidate.Id)).toEqual(["s1e1-started"]);
  });

  it("drops the show completely when the latest episode is completed and NextUp returns nothing", () => {
    const finishedResumeItem = episode("s1e1", 1, 1, {
      UserData: { PlaybackPositionTicks: 94 },
    });

    const result = buildSmartContinueWatchingItems([finishedResumeItem], []);

    expect(result).toEqual([]);
  });

  it("keeps genuinely unfinished movie resumes", () => {
    const movie = item("movie-1", {
      Type: "Movie",
      Name: "Batman Returns",
      RunTimeTicks: 100,
      UserData: { PlaybackPositionTicks: 50 },
    });

    const result = buildSmartContinueWatchingItems([movie], []);

    expect(result.map((candidate) => candidate.Id)).toEqual(["movie-1"]);
  });
});
