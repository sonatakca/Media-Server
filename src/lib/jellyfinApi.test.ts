import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuthSession } from "./authStorage";
import { clearContinueWatchingHistory } from "./continueWatchingActions";
import {
  getMediaSegments,
  getNextEpisodeInSeason,
  getUserViews,
  JELLYFIN_SERVER_UNAVAILABLE_EVENT,
  markItemWatchedStatus,
} from "./jellyfinApi";

describe("getMediaSegments", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    const storage = new Map<string, string>();
    const localStorageMock: Storage = {
      get length() {
        return storage.size;
      },
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };

    fetchMock.mockReset();
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.stubGlobal("localStorage", localStorageMock);
    vi.stubGlobal("fetch", fetchMock);
    setAuthSession({
      serverUrl: "http://jellyfin.local",
      accessToken: "mock-token",
      userId: "user-1",
      username: "Test User",
      deviceId: "device-1",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes array-like media segment responses", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          Items: [
            {
              Id: "outro-1",
              Type: "Outro",
              Start: 100,
              End: 120,
            },
            {
              Id: "intro-1",
              Type: "Intro",
              StartTicks: 30_000_000,
              EndTicks: 90_000_000,
            },
            {
              Id: "invalid-1",
              Type: "Recap",
              StartTicks: 50_000_000,
              EndTicks: 40_000_000,
            },
            {
              Id: "invalid-2",
              StartTicks: 50_000_000,
              EndTicks: 60_000_000,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(getMediaSegments("movie-1")).resolves.toEqual([
      {
        id: "intro-1",
        type: "Intro",
        startSeconds: 3,
        endSeconds: 9,
      },
      {
        id: "outro-1",
        type: "Outro",
        startSeconds: 100,
        endSeconds: 120,
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://jellyfin.local/MediaSegments/movie-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Emby-Token": "mock-token",
        }),
      }),
    );
  });

  it("returns an empty list when Jellyfin does not expose the endpoint", async () => {
    const debugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(
      new Response("", { status: 404, statusText: "Not Found" }),
    );

    await expect(getMediaSegments("movie-1")).resolves.toEqual([]);
    expect(debugSpy).toHaveBeenCalled();
  });

  it("signals when the configured server becomes unreachable", async () => {
    const unavailableHandler = vi.fn();
    window.addEventListener(
      JELLYFIN_SERVER_UNAVAILABLE_EVENT,
      unavailableHandler,
    );
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(getUserViews()).rejects.toThrow("Failed to fetch");
    expect(unavailableHandler).toHaveBeenCalledTimes(1);

    window.removeEventListener(
      JELLYFIN_SERVER_UNAVAILABLE_EVENT,
      unavailableHandler,
    );
  });
});

describe("getNextEpisodeInSeason", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    const storage = new Map<string, string>();
    const localStorageMock: Storage = {
      get length() {
        return storage.size;
      },
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };

    fetchMock.mockReset();
    vi.stubGlobal("localStorage", localStorageMock);
    vi.stubGlobal("fetch", fetchMock);
    setAuthSession({
      serverUrl: "http://jellyfin.local",
      accessToken: "mock-token",
      userId: "user-1",
      username: "Test User",
      deviceId: "device-1",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns the next higher-index episode from the same season", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          Items: [
            {
              Id: "episode-4",
              Name: "Episode 4",
              Type: "Episode",
              SeasonId: "season-1",
              IndexNumber: 4,
            },
            {
              Id: "episode-2",
              Name: "Episode 2",
              Type: "Episode",
              SeasonId: "season-1",
              IndexNumber: 2,
            },
            {
              Id: "episode-3",
              Name: "Episode 3",
              Type: "Episode",
              SeasonId: "season-1",
              IndexNumber: 3,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(
      getNextEpisodeInSeason({
        Id: "episode-2",
        Name: "Episode 2",
        Type: "Episode",
        SeriesId: "series-1",
        SeasonId: "season-1",
        IndexNumber: 2,
      }),
    ).resolves.toMatchObject({
      Id: "episode-3",
      IndexNumber: 3,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("http://jellyfin.local/Shows/Episodes"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Emby-Token": "mock-token",
        }),
      }),
    );
  });

  it.each([
    ["S1E3 · Aşk Ölümden Güçlüdür", "S1E4 · En Zoru Eve Dönmektir"],
    ["S01E03 · Aşk Ölümden Güçlüdür", "S01E04 · En Zoru Eve Dönmektir"],
    ["1x03 · Aşk Ölümden Güçlüdür", "1x04 · En Zoru Eve Dönmektir"],
    ["E3 · Aşk Ölümden Güçlüdür", "E4 · En Zoru Eve Dönmektir"],
    ["Episode 3 · Aşk Ölümden Güçlüdür", "Episode 4 · En Zoru Eve Dönmektir"],
    ["Bölüm 3 · Aşk Ölümden Güçlüdür", "Bölüm 4 · En Zoru Eve Dönmektir"],
    ["Bolum 3 · Ask Olumden Gucludur", "Bolum 4 · En Zoru Eve Donmektir"],
    ["Böl 3 · Aşk Ölümden Güçlüdür", "Böl 4 · En Zoru Eve Dönmektir"],
  ])(
    "parses episode order from labels like %s",
    async (currentName, nextName) => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            Items: [
              {
                Id: "episode-5",
                Name: "S1E5 · Later",
                Type: "Episode",
                SeasonId: "season-1",
              },
              {
                Id: "episode-4",
                Name: nextName,
                Type: "Episode",
                SeasonId: "season-1",
              },
              {
                Id: "episode-3",
                Name: currentName,
                Type: "Episode",
                SeasonId: "season-1",
              },
            ],
          }),
          { status: 200 },
        ),
      );

      await expect(
        getNextEpisodeInSeason({
          Id: "episode-3",
          Name: currentName,
          Type: "Episode",
          SeriesId: "series-1",
          SeasonId: "season-1",
        }),
      ).resolves.toMatchObject({
        Id: "episode-4",
        Name: nextName,
      });
    },
  );

  it("falls back to the season parent items endpoint when the series endpoint is empty", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ Items: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Items: [
              {
                Id: "episode-4",
                Name: "S1E4 · En Zoru Eve Dönmektir",
                Type: "Episode",
                SeasonId: "season-1",
              },
            ],
          }),
          { status: 200 },
        ),
      );

    await expect(
      getNextEpisodeInSeason({
        Id: "episode-3",
        Name: "S1E3 · Aşk Ölümden Güçlüdür",
        Type: "Episode",
        SeriesId: "series-1",
        SeasonId: "season-1",
      }),
    ).resolves.toMatchObject({
      Id: "episode-4",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/Shows/Episodes");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/Items");
  });

  it("falls back to native Jellyfin order when episode numbers cannot be parsed", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          Items: [
            {
              Id: "episode-3",
              Name: "Aşk Ölümden Güçlüdür",
              Type: "Episode",
              SeasonId: "season-1",
            },
            {
              Id: "episode-4",
              Name: "En Zoru Eve Dönmektir",
              Type: "Episode",
              SeasonId: "season-1",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(
      getNextEpisodeInSeason({
        Id: "episode-3",
        Name: "Aşk Ölümden Güçlüdür",
        Type: "Episode",
        SeriesId: "series-1",
        SeasonId: "season-1",
      }),
    ).resolves.toMatchObject({
      Id: "episode-4",
    });
  });

  it("returns null for the last episode in a season", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          Items: [
            {
              Id: "episode-3",
              Name: "Episode 3",
              Type: "Episode",
              SeasonId: "season-1",
              IndexNumber: 3,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(
      getNextEpisodeInSeason({
        Id: "episode-3",
        Name: "Episode 3",
        Type: "Episode",
        SeriesId: "series-1",
        SeasonId: "season-1",
        IndexNumber: 3,
      }),
    ).resolves.toBeNull();
  });

  it("does not fetch anything for non-episode items", async () => {
    await expect(
      getNextEpisodeInSeason({
        Id: "movie-1",
        Name: "Movie",
        Type: "Movie",
        IndexNumber: 1,
      }),
    ).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("clearContinueWatchingHistory", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    const storage = new Map<string, string>();
    const localStorageMock: Storage = {
      get length() {
        return storage.size;
      },
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };

    fetchMock.mockReset();
    vi.stubGlobal("localStorage", localStorageMock);
    vi.stubGlobal("fetch", fetchMock);
    setAuthSession({
      serverUrl: "http://jellyfin.local",
      accessToken: "mock-token",
      userId: "user-1",
      username: "Test User",
      deviceId: "device-1",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clears a movie playback history and restarts that movie", async () => {
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (url.includes("/Items/movie-1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Id: "movie-1",
              Name: "Movie",
              Type: "Movie",
              UserData: { Played: true, PlaybackPositionTicks: 100 },
            }),
            { status: 200 },
          ),
        );
      }

      expect(options?.method).toBe("POST");
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    const movie = {
      Id: "movie-1",
      Name: "Movie",
      Type: "Movie",
    };

    await expect(clearContinueWatchingHistory(movie)).resolves.toEqual(movie);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/UserItems/movie-1/UserData?userId=user-1"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"PlaybackPositionTicks":0'),
      }),
    );
  });

  it("falls back to the legacy unplayed endpoint used by older servers", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Id: "movie-1",
            Name: "Movie",
            Type: "Movie",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await clearContinueWatchingHistory({
      Id: "movie-1",
      Name: "Movie",
      Type: "Movie",
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/UserItems/movie-1/UserData",
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      "/UserPlayedItems/movie-1?userId=user-1",
    );
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain(
      "/Users/user-1/PlayedItems/movie-1",
    );
  });

  it("marks an item watched through Jellyfin user data", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Id: "movie-1",
            Name: "Movie",
            Type: "Movie",
            RunTimeTicks: 1_000,
            UserData: {
              PlaybackPositionTicks: 0,
              Played: false,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            PlaybackPositionTicks: 1_000,
            PlayedPercentage: 100,
            Played: true,
          }),
          { status: 200 },
        ),
      );

    await markItemWatchedStatus("movie-1");

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/UserItems/movie-1/UserData",
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      PlaybackPositionTicks: 1_000,
      PlayedPercentage: 100,
      Played: true,
    });
  });

  it("clears every series episode and starts at the earliest episode", async () => {
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (url.includes("/Shows/series-1/Episodes")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Items: [
                {
                  Id: "season-2-episode-1",
                  Name: "Episode 1",
                  Type: "Episode",
                  SeriesId: "series-1",
                  ParentIndexNumber: 2,
                  IndexNumber: 1,
                },
                {
                  Id: "season-1-episode-2",
                  Name: "Episode 2",
                  Type: "Episode",
                  SeriesId: "series-1",
                  ParentIndexNumber: 1,
                  IndexNumber: 2,
                },
                {
                  Id: "season-1-episode-1",
                  Name: "Episode 1",
                  Type: "Episode",
                  SeriesId: "series-1",
                  ParentIndexNumber: 1,
                  IndexNumber: 1,
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }

      if (url.includes("/Items/")) {
        const itemId = url.match(/Items\/([^?]+)/)?.[1];

        return Promise.resolve(
          new Response(
            JSON.stringify({
              Id: itemId,
              Name: itemId,
              Type: "Episode",
            }),
            { status: 200 },
          ),
        );
      }

      expect(options?.method).toBe("POST");
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    await expect(
      clearContinueWatchingHistory({
        Id: "season-1-episode-2",
        Name: "Episode 2",
        Type: "Episode",
        SeriesId: "series-1",
        ParentIndexNumber: 1,
        IndexNumber: 2,
      }),
    ).resolves.toMatchObject({
      Id: "season-1-episode-1",
    });

    const requestUrls = fetchMock.mock.calls.map(([url]) => String(url));

    expect(requestUrls[0]).toContain("/Shows/series-1/Episodes");
    expect(
      requestUrls
        .filter((url) => url.includes("/UserItems/"))
        .map((url) => url.match(/UserItems\/([^/]+)/)?.[1])
        .sort(),
    ).toEqual(
      ["season-1-episode-1", "season-1-episode-2", "season-2-episode-1"].sort(),
    );
  });
});
