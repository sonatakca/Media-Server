import { expect, it, vi } from "vitest";
import { createTmdbClient } from "./tmdbClient";
it("searches the TV catalogue with page, artwork and title identity", async () => {
  const fetchImpl = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          total_pages: 3,
          results: [
            {
              id: 94605,
              name: "Arcane",
              first_air_date: "2021-11-06",
              poster_path: "/arcane.jpg",
              overview: "Two sisters.",
            },
          ],
        }),
        { status: 200 },
      ),
  );
  const client = createTmdbClient({
    apiKey: "test",
    fetchImpl: fetchImpl as typeof fetch,
  });
  const result = await client.catalogue!("tv", "Arcane", 2);
  const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
  expect(url.pathname).toBe("/3/search/tv");
  expect(url.searchParams.get("query")).toBe("Arcane");
  expect(url.searchParams.get("page")).toBe("2");
  expect(result).toMatchObject({
    totalPages: 3,
    items: [
      {
        providerId: "94605",
        title: "Arcane",
        kind: "series",
        year: 2021,
        posterUrl: "https://image.tmdb.org/t/p/w185/arcane.jpg",
      },
    ],
  });
});
it("browses movies without a search and rejects arbitrary poster URLs", async () => {
  const fetchImpl = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          total_pages: 900,
          results: [
            {
              id: 550,
              title: "Fight Club",
              poster_path: "https://attacker.example/image.jpg",
            },
          ],
        }),
        { status: 200 },
      ),
  );
  const client = createTmdbClient({
    apiKey: "test",
    fetchImpl: fetchImpl as typeof fetch,
  });
  const result = await client.catalogue!("movie", "", 1);
  expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).pathname).toBe(
    "/3/movie/popular",
  );
  expect(result.totalPages).toBe(500);
  expect(result.items[0]?.posterUrl).toBeUndefined();
});
