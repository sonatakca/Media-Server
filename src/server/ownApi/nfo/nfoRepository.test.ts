import { describe, expect, it } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import { createNfoRepository, NFO_EXPORTABLE_KINDS } from "./nfoRepository";

/**
 * The repository is exercised against a recording stub rather than PostgreSQL.
 *
 * What matters here is the shape of the access: how many statements one batch
 * costs, that ids are chunked rather than sent as one unbounded array, and that
 * the rows are folded back onto the right items. Whether the SQL is valid is the
 * database integration suite's job.
 */

interface RecordedQuery {
  sql: string;
  values: unknown[];
}

function stubPool(rows: Record<string, Array<Record<string, unknown>>>) {
  const queries: RecordedQuery[] = [];

  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      for (const [marker, result] of Object.entries(rows)) {
        if (sql.includes(marker))
          return { rows: result, rowCount: result.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as DatabasePool;

  return { pool, queries };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    library_id: "bbbbbbbb-2222-4222-8222-222222222222",
    parent_id: null,
    series_id: null,
    kind: "movie",
    source_key: "movie:movies/dune (2021)",
    title: "Dune",
    sort_title: "dune",
    original_title: null,
    overview: null,
    tagline: null,
    production_year: 2021,
    premiere_date: null,
    end_date: null,
    official_rating: null,
    community_rating: null,
    runtime_ms: "9180000",
    index_number: null,
    parent_index_number: null,
    provider_ids: { tmdb: "438631" },
    series_title: null,
    series_source_key: null,
    descendant_relative_path: null,
    series_descendant_relative_path: null,
    ...overrides,
  };
}

describe("nfo repository", () => {
  describe("loadBundles", () => {
    it("costs a fixed handful of statements for a whole batch", async () => {
      const { pool, queries } = stubPool({
        "FROM items i": [
          itemRow(),
          itemRow({ id: "aaaaaaaa-1111-4111-8111-111111111112" }),
          itemRow({ id: "aaaaaaaa-1111-4111-8111-111111111113" }),
        ],
        "FROM media_files": [
          {
            id: "cccccccc-3333-4333-8333-333333333333",
            item_id: "aaaaaaaa-1111-4111-8111-111111111111",
            relative_path: "Movies/Dune (2021)/Dune.mkv",
            container: "mkv",
            duration_ms: "9180000",
            is_primary: true,
          },
        ],
        "FROM media_streams": [
          {
            media_file_id: "cccccccc-3333-4333-8333-333333333333",
            stream_index: 0,
            kind: "video",
            codec: "hevc",
            language: null,
            is_default: true,
            is_forced: false,
            channels: null,
            width: 3840,
            height: 2160,
            bit_depth: 10,
            video_range: "HDR10",
          },
        ],
        "FROM item_genres": [
          {
            item_id: "aaaaaaaa-1111-4111-8111-111111111111",
            name: "Science Fiction",
            sort_order: 0,
          },
        ],
        "FROM item_people": [
          {
            item_id: "aaaaaaaa-1111-4111-8111-111111111111",
            name: "Denis Villeneuve",
            role: "director",
            character_name: null,
            sort_order: 0,
            provider_ids: {},
          },
        ],
      });

      const bundles = await createNfoRepository(pool).loadBundles([
        "aaaaaaaa-1111-4111-8111-111111111111",
        "aaaaaaaa-1111-4111-8111-111111111112",
        "aaaaaaaa-1111-4111-8111-111111111113",
      ]);

      expect(bundles).toHaveLength(3);
      // Items, files, genres, people, streams — and no season query, because
      // this batch had no seasons in it.
      expect(queries).toHaveLength(5);
    });

    it("attaches files, streams, genres and people to the right item", async () => {
      const { pool } = stubPool({
        "FROM items i": [
          itemRow(),
          itemRow({ id: "aaaaaaaa-1111-4111-8111-111111111112" }),
        ],
        "FROM media_files": [
          {
            id: "cccccccc-3333-4333-8333-333333333333",
            item_id: "aaaaaaaa-1111-4111-8111-111111111111",
            relative_path: "Movies/Dune (2021)/Dune.mkv",
            container: "mkv",
            duration_ms: null,
            is_primary: true,
          },
        ],
        "FROM media_streams": [
          {
            media_file_id: "cccccccc-3333-4333-8333-333333333333",
            stream_index: 1,
            kind: "audio",
            codec: "eac3",
            language: "tur",
            is_default: true,
            is_forced: false,
            channels: 6,
            width: null,
            height: null,
            bit_depth: null,
            video_range: null,
          },
        ],
        "FROM item_genres": [
          {
            item_id: "aaaaaaaa-1111-4111-8111-111111111112",
            name: "Drama",
            sort_order: 0,
          },
        ],
      });

      const [first, second] = await createNfoRepository(pool).loadBundles([
        "aaaaaaaa-1111-4111-8111-111111111111",
        "aaaaaaaa-1111-4111-8111-111111111112",
      ]);

      expect(first?.files).toHaveLength(1);
      expect(first?.streams[0]?.channels).toBe(6);
      expect(first?.genres).toEqual([]);
      expect(second?.files).toEqual([]);
      expect(second?.genres[0]?.name).toBe("Drama");
    });

    it("asks for a season's episode directories only when a season is present", async () => {
      const { pool, queries } = stubPool({
        "FROM items i": [itemRow({ kind: "season", index_number: 1 })],
        "FROM items child": [
          {
            season_id: "aaaaaaaa-1111-4111-8111-111111111111",
            directory: "Series/Şahsiyet/Season 01",
          },
        ],
      });

      const [bundle] = await createNfoRepository(pool).loadBundles([
        "aaaaaaaa-1111-4111-8111-111111111111",
      ]);

      expect(bundle?.seasonEpisodeDirectories).toEqual([
        "Series/Şahsiyet/Season 01",
      ]);
      expect(
        queries.some((query) => query.sql.includes("FROM items child")),
      ).toBe(true);
    });

    it("chunks a large request instead of sending one unbounded array", async () => {
      const ids = Array.from(
        { length: 250 },
        (_, index) =>
          `aaaaaaaa-1111-4111-8111-${String(index).padStart(12, "0")}`,
      );
      const { pool, queries } = stubPool({
        "FROM items i": [itemRow()],
      });

      await createNfoRepository(pool).loadBundles(ids);

      const itemQueries = queries.filter((query) =>
        query.sql.includes("FROM items i"),
      );
      expect(itemQueries).toHaveLength(3);
      for (const query of itemQueries) {
        expect((query.values[0] as string[]).length).toBeLessThanOrEqual(100);
      }
    });

    it("de-duplicates ids and preserves the order it was asked for", async () => {
      const { pool, queries } = stubPool({
        "FROM items i": [
          itemRow({ id: "aaaaaaaa-1111-4111-8111-111111111112" }),
          itemRow(),
        ],
      });

      const bundles = await createNfoRepository(pool).loadBundles([
        "aaaaaaaa-1111-4111-8111-111111111111",
        "aaaaaaaa-1111-4111-8111-111111111112",
        "aaaaaaaa-1111-4111-8111-111111111111",
      ]);

      expect(bundles.map((bundle) => bundle.item.id)).toEqual([
        "aaaaaaaa-1111-4111-8111-111111111111",
        "aaaaaaaa-1111-4111-8111-111111111112",
      ]);
      expect((queries[0]?.values[0] as string[]).length).toBe(2);
    });

    it("does no work at all for an empty request", async () => {
      const { pool, queries } = stubPool({});

      expect(await createNfoRepository(pool).loadBundles([])).toEqual([]);
      expect(queries).toHaveLength(0);
    });

    it("keeps runtime as a string rather than widening a bigint", async () => {
      const { pool } = stubPool({ "FROM items i": [itemRow()] });

      const [bundle] = await createNfoRepository(pool).loadBundles([
        "aaaaaaaa-1111-4111-8111-111111111111",
      ]);

      expect(bundle?.item.runtimeMs).toBe("9180000");
    });
  });

  describe("listExportableItemIds", () => {
    it("pages by key rather than by offset", async () => {
      const { pool, queries } = stubPool({
        "SELECT id FROM items": [
          { id: "aaaaaaaa-1111-4111-8111-111111111111" },
        ],
      });

      await createNfoRepository(pool).listExportableItemIds("library-1", {
        limit: 100,
        after: "aaaaaaaa-1111-4111-8111-111111111110",
      });

      expect(queries[0]?.sql).toContain("id > $3::uuid");
      expect(queries[0]?.sql).not.toContain("OFFSET");
      expect(queries[0]?.values).toEqual([
        "library-1",
        NFO_EXPORTABLE_KINDS,
        "aaaaaaaa-1111-4111-8111-111111111110",
        100,
      ]);
    });

    it("asks only for the kinds an .nfo can describe", async () => {
      const { pool, queries } = stubPool({ "SELECT id FROM items": [] });

      await createNfoRepository(pool).listExportableItemIds("library-1", {
        limit: 10,
      });

      expect(queries[0]?.values[1]).toEqual([
        "movie",
        "series",
        "season",
        "episode",
      ]);
      expect(queries[0]?.values[2]).toBeNull();
    });
  });

  it("counts the exportable items in a library", async () => {
    const { pool } = stubPool({ "SELECT count(*)": [{ count: "1234" }] });

    expect(
      await createNfoRepository(pool).countExportableItems("library-1"),
    ).toBe(1234);
  });

  it("resolves the library an item belongs to", async () => {
    const { pool } = stubPool({
      "FROM items i JOIN libraries": [
        { id: "library-1", slug: "movies", name: "Movies" },
      ],
    });

    expect(
      await createNfoRepository(pool).getLibraryForItem("item-1"),
    ).toMatchObject({ slug: "movies" });
  });
});
