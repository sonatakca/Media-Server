import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuthSession } from "./authStorage";
import { getMediaSegments } from "./jellyfinApi";

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
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(new Response("", { status: 404, statusText: "Not Found" }));

    await expect(getMediaSegments("movie-1")).resolves.toEqual([]);
    expect(debugSpy).toHaveBeenCalled();
  });
});
