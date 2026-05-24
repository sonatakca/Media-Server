import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuthSession } from "./authStorage";
import { getMediaSegments, getNextEpisodeInSeason } from "./jellyfinApi";

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
