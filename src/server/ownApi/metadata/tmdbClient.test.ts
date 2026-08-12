import { describe, expect, it, vi } from "vitest";
import { createTmdbClient, isV4ReadAccessToken, TmdbError } from "./tmdbClient";

const V3_KEY = "d0000000000000000000000000000000";
const V4_TOKEN = "eyJhbGciOiJIUzI1NiJ9.payload.signature";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Captures the request the client would send, without making one. */
function captureFetch(body: unknown = { results: [] }) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return jsonResponse(body);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("isV4ReadAccessToken", () => {
  it("recognizes a v4 read access token by its JWT prefix", () => {
    expect(isV4ReadAccessToken(V4_TOKEN)).toBe(true);
    expect(isV4ReadAccessToken(`  ${V4_TOKEN}`)).toBe(true);
  });

  it("treats a 32-character hex key as v3", () => {
    expect(isV4ReadAccessToken(V3_KEY)).toBe(false);
  });
});

describe("TMDB credential handling", () => {
  /**
   * TMDB rejects a v3 key sent as a bearer token with 401. This was a real
   * failure against the live API, so both schemes are pinned here.
   */
  it("sends a v3 key as the api_key query parameter and no Authorization header", async () => {
    const { calls, fetchImpl } = captureFetch();
    await createTmdbClient({ apiKey: V3_KEY, fetchImpl }).searchMovies(
      "Dune",
      2021,
    );

    const call = calls[0];
    expect(call?.url.searchParams.get("api_key")).toBe(V3_KEY);
    expect(call?.headers.Authorization).toBeUndefined();
  });

  it("sends a v4 token as a bearer header and keeps it out of the query", async () => {
    const { calls, fetchImpl } = captureFetch();
    await createTmdbClient({ apiKey: V4_TOKEN, fetchImpl }).searchMovies(
      "Dune",
    );

    const call = calls[0];
    expect(call?.headers.Authorization).toBe(`Bearer ${V4_TOKEN}`);
    expect(call?.url.searchParams.get("api_key")).toBeNull();
  });

  it("refuses to start without a key rather than failing at the first lookup", () => {
    expect(() => createTmdbClient({ apiKey: "   " })).toThrow(
      "SEYIRLIK_TMDB_API_KEY is required",
    );
  });

  it("passes the search query and year through", async () => {
    const { calls, fetchImpl } = captureFetch();
    await createTmdbClient({ apiKey: V3_KEY, fetchImpl }).searchMovies(
      "Dune Part Two",
      2024,
    );

    expect(calls[0]?.url.searchParams.get("query")).toBe("Dune Part Two");
    expect(calls[0]?.url.searchParams.get("year")).toBe("2024");
  });

  it("uses the series date parameter when searching shows", async () => {
    const { calls, fetchImpl } = captureFetch();
    await createTmdbClient({ apiKey: V3_KEY, fetchImpl }).searchSeries(
      "Andor",
      2022,
    );

    expect(calls[0]?.url.pathname).toContain("/search/tv");
    expect(calls[0]?.url.searchParams.get("first_air_date_year")).toBe("2022");
  });

  it("maps provider status codes to typed errors", async () => {
    const notFound = createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl: (async () => jsonResponse({}, 404)) as unknown as typeof fetch,
    });
    await expect(notFound.getMovie("1")).rejects.toMatchObject({
      kind: "not-found",
    });

    const rateLimited = createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl: (async () => jsonResponse({}, 429)) as unknown as typeof fetch,
    });
    await expect(rateLimited.getMovie("1")).rejects.toMatchObject({
      kind: "rate-limited",
    });
  });

  it("never puts the credential into an error message", async () => {
    const client = createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch,
    });

    const error = await client.getMovie("1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TmdbError);
    expect((error as Error).message).not.toContain(V3_KEY);
  });
});

describe("artwork listing", () => {
  const IMAGES = {
    posters: [
      {
        file_path: "/low.jpg",
        iso_639_1: "tr",
        width: 600,
        height: 900,
        aspect_ratio: 0.667,
        vote_average: 5.2,
        vote_count: 3,
      },
      {
        file_path: "/best.jpg",
        iso_639_1: "en",
        width: 2000,
        height: 3000,
        aspect_ratio: 0.667,
        vote_average: 8.1,
        vote_count: 40,
      },
      { file_path: "/broken.jpg" },
    ],
    backdrops: [
      {
        file_path: "/wide.jpg",
        iso_639_1: "",
        width: 3840,
        height: 2160,
        aspect_ratio: 1.778,
        vote_average: 6,
        vote_count: 9,
      },
    ],
    logos: [{ file_path: "/logo.png", iso_639_1: "tr" }],
  };

  it("asks for every language rather than the configured one", async () => {
    // A picker that only ever showed the configured language would have no
    // reason to exist: choosing the Turkish poster over the English one is the
    // whole point.
    const { calls, fetchImpl } = captureFetch(IMAGES);
    await createTmdbClient({
      apiKey: V3_KEY,
      language: "tr-TR",
      fetchImpl,
    }).listArtwork("movie", "438631");

    const call = calls[0];
    expect(call?.url.pathname).toBe("/3/movie/438631/images");
    expect(call?.url.searchParams.get("language")).toBeNull();
  });

  it("ranks candidates by vote and reads a blank language as language-neutral", async () => {
    const { fetchImpl } = captureFetch(IMAGES);
    const artwork = await createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl,
    }).listArtwork("movie", "438631");

    const posters = artwork.filter((image) => image.kind === "poster");
    expect(posters.map((image) => image.filePath)).toEqual([
      "/best.jpg",
      "/low.jpg",
      "/broken.jpg",
    ]);
    expect(posters[0]).toMatchObject({
      language: "en",
      width: 2000,
      voteCount: 40,
    });

    // TMDB writes "" for artwork with no text, which is a category of its own
    // and not a missing value.
    expect(
      artwork.find((image) => image.kind === "backdrop")?.language,
    ).toBeNull();
    expect(artwork.filter((image) => image.kind === "logo")).toHaveLength(1);
  });

  it("keeps a title lookup in the language it was asked for", async () => {
    const { calls, fetchImpl } = captureFetch({ title: "Düne" });
    await createTmdbClient({
      apiKey: V3_KEY,
      language: "en-US",
      fetchImpl,
    }).getMovie("438631", "tr-TR");

    expect(calls[0]?.url.searchParams.get("language")).toBe("tr-TR");
    expect(calls[0]?.url.searchParams.get("include_image_language")).toBe(
      "tr,en,null",
    );
  });
});
