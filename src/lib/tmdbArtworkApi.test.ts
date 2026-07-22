import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchTmdbArtwork } from "./tmdbArtworkApi";
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
});
