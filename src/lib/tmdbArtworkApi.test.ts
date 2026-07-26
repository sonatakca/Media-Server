import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTmdbLocalizedMetadata, searchTmdbArtwork } from "./tmdbArtworkApi";
import { getAdminIdToken } from "./firebaseAdminAuth";

vi.mock("./firebaseAdminAuth", () => ({
  getAdminIdToken: vi.fn(),
}));

describe("TMDB artwork administrator requests", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_SEYIRLIK_PLAYBACK_BACKEND_URL", "http://127.0.0.1:43110");
    vi.mocked(getAdminIdToken).mockResolvedValue("firebase-admin-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sends the Firebase ID token as a bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await searchTmdbArtwork({
      mediaType: "movie",
      query: "Arrival",
      language: "en",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(options.headers).toMatchObject({
      Authorization: "Bearer firebase-admin-token",
    });
  });

  it("does not call the administrator backend without an authorized user", async () => {
    vi.mocked(getAdminIdToken).mockRejectedValue(
      new Error("Authorized Google administrator sign-in is required."),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchTmdbArtwork({
        mediaType: "movie",
        query: "Arrival",
        language: "en",
      }),
    ).rejects.toThrow("Authorized Google administrator sign-in is required.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to localized search when the deployed metadata route is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "NOT_FOUND",
              message: "TMDB artwork route not found.",
            },
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                id: 550,
                mediaType: "movie",
                title: "Dövüş Kulübü",
                overview: "Türkçe açıklama.",
                year: 1999,
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getTmdbLocalizedMetadata({
        mediaType: "movie",
        tmdbId: 550,
        language: "tr",
        query: "Fight Club",
        year: 1999,
      }),
    ).resolves.toMatchObject({
      tmdbId: 550,
      language: "tr",
      title: "Dövüş Kulübü",
      overview: "Türkçe açıklama.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "/api/tmdb-artwork/search",
    );
  });
});
