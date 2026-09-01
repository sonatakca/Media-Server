import type { DatabasePool } from "../database/databasePool";
import { resolveTitleRoot } from "../metadata/titleRoot";

/**
 * Catalogue reads for the NFO exporter.
 *
 * Everything an export needs is loaded in a fixed number of queries per batch —
 * items, files, streams, genres, people, and the two pieces of context a season
 * and an episode need from their series. A per-item query would be simpler to
 * write and would turn a library export into hundreds of thousands of round
 * trips against the same pool the player is using.
 */

export interface NfoItemRow {
  id: string;
  libraryId: string;
  parentId: string | null;
  seriesId: string | null;
  kind: string;
  sourceKey: string;
  title: string;
  sortTitle: string;
  originalTitle: string | null;
  overview: string | null;
  tagline: string | null;
  productionYear: number | null;
  premiereDate: Date | null;
  endDate: Date | null;
  officialRating: string | null;
  communityRating: number | null;
  /** `bigint` arrives as a string; never widened to a number here. */
  runtimeMs: string | null;
  indexNumber: number | null;
  parentIndexNumber: number | null;
  providerIds: Record<string, string>;
}

export interface NfoFileRow {
  id: string;
  itemId: string;
  relativePath: string;
  container: string | null;
  durationMs: string | null;
  isPrimary: boolean;
}

export interface NfoStreamRow {
  mediaFileId: string;
  streamIndex: number;
  kind: string;
  codec: string | null;
  language: string | null;
  isDefault: boolean;
  isForced: boolean;
  channels: number | null;
  width: number | null;
  height: number | null;
  bitDepth: number | null;
  videoRange: string | null;
}

export interface NfoGenreRow {
  itemId: string;
  name: string;
  sortOrder: number;
}

export interface NfoPersonRow {
  itemId: string;
  name: string;
  role: string;
  characterName: string | null;
  sortOrder: number;
  providerIds: Record<string, string>;
}

/** One item and everything its .nfo files need. */
export interface NfoItemBundle {
  item: NfoItemRow;
  files: NfoFileRow[];
  streams: NfoStreamRow[];
  genres: NfoGenreRow[];
  people: NfoPersonRow[];
  /** Episodes: the show name that goes in `<showtitle>`. */
  seriesTitle?: string | null;
  /** Seasons: used to tell a real season folder from a flat series folder. */
  seriesTitleRoot?: string | undefined;
  /** Series: any descendant path, which is how a series folder is recovered. */
  descendantRelativePath?: string | null;
  /** Seasons: the distinct directories this season's episodes live in. */
  seasonEpisodeDirectories?: string[];
}

export interface NfoLibrary {
  id: string;
  slug: string;
  name: string;
}

export interface NfoRepository {
  getLibrary(libraryId: string): Promise<NfoLibrary | null>;
  /** The library an item belongs to, for the Arr-ownership check. */
  getLibraryForItem(itemId: string): Promise<NfoLibrary | null>;
  listExportableItemIds(
    libraryId: string,
    options: { after?: string; limit: number },
  ): Promise<string[]>;
  countExportableItems(libraryId: string): Promise<number>;
  loadBundles(itemIds: string[]): Promise<NfoItemBundle[]>;
}

/** Kinds an .nfo can describe; books, collections and trailers are excluded. */
export const NFO_EXPORTABLE_KINDS = ["movie", "series", "season", "episode"];

/**
 * How many ids go into one `= ANY(...)` array.
 *
 * Small enough that the planner keeps using the indexes, large enough that a
 * library export is a handful of queries per batch rather than one per title.
 */
const ID_CHUNK = 100;

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(key(row));
    if (bucket) bucket.push(row);
    else grouped.set(key(row), [row]);
  }
  return grouped;
}

interface RawItemRow {
  id: string;
  library_id: string;
  parent_id: string | null;
  series_id: string | null;
  kind: string;
  source_key: string;
  title: string;
  sort_title: string;
  original_title: string | null;
  overview: string | null;
  tagline: string | null;
  production_year: number | null;
  premiere_date: Date | null;
  end_date: Date | null;
  official_rating: string | null;
  community_rating: number | null;
  runtime_ms: string | null;
  index_number: number | null;
  parent_index_number: number | null;
  provider_ids: Record<string, string> | null;
  series_title: string | null;
  series_source_key: string | null;
  descendant_relative_path: string | null;
  series_descendant_relative_path: string | null;
}

const ITEM_QUERY = `
  SELECT
    i.id, i.library_id, i.parent_id, i.series_id, i.kind, i.source_key,
    i.title, i.sort_title, i.original_title, i.overview, i.tagline,
    i.production_year, i.premiere_date, i.end_date, i.official_rating,
    i.community_rating, i.runtime_ms, i.index_number, i.parent_index_number,
    i.provider_ids,
    series.title AS series_title,
    series.source_key AS series_source_key,
    -- A series owns no file, so its folder is only recoverable from a
    -- descendant's path. Ordered by path rather than by insertion so the same
    -- catalogue always yields the same folder.
    (SELECT mf.relative_path
       FROM media_files mf
       JOIN items child ON child.id = mf.item_id
      WHERE child.series_id = i.id
      ORDER BY mf.relative_path
      LIMIT 1) AS descendant_relative_path,
    (SELECT mf.relative_path
       FROM media_files mf
       JOIN items child ON child.id = mf.item_id
      WHERE child.series_id = series.id
      ORDER BY mf.relative_path
      LIMIT 1) AS series_descendant_relative_path
  FROM items i
  LEFT JOIN items series ON series.id = i.series_id
  WHERE i.id = ANY($1::uuid[])
`;

function toItemRow(row: RawItemRow): NfoItemRow {
  return {
    id: row.id,
    libraryId: row.library_id,
    parentId: row.parent_id,
    seriesId: row.series_id,
    kind: row.kind,
    sourceKey: row.source_key,
    title: row.title,
    sortTitle: row.sort_title,
    originalTitle: row.original_title,
    overview: row.overview,
    tagline: row.tagline,
    productionYear: row.production_year,
    premiereDate: row.premiere_date,
    endDate: row.end_date,
    officialRating: row.official_rating,
    communityRating: row.community_rating,
    runtimeMs: row.runtime_ms,
    indexNumber: row.index_number,
    parentIndexNumber: row.parent_index_number,
    providerIds: row.provider_ids ?? {},
  };
}

export function createNfoRepository(pool: DatabasePool): NfoRepository {
  async function loadChunk(itemIds: string[]): Promise<NfoItemBundle[]> {
    const items = await pool.query<RawItemRow>(ITEM_QUERY, [itemIds]);
    if (items.rows.length === 0) return [];

    const presentIds = items.rows.map((row) => row.id);
    const seasonIds = items.rows
      .filter((row) => row.kind === "season")
      .map((row) => row.id);

    const [files, genres, people] = await Promise.all([
      pool.query<{
        id: string;
        item_id: string;
        relative_path: string;
        container: string | null;
        duration_ms: string | null;
        is_primary: boolean;
      }>(
        `SELECT id, item_id, relative_path, container, duration_ms, is_primary
           FROM media_files
          WHERE item_id = ANY($1::uuid[]) AND missing_since IS NULL
          ORDER BY item_id, is_primary DESC, relative_path`,
        [presentIds],
      ),
      pool.query<{ item_id: string; name: string; sort_order: number }>(
        `SELECT ig.item_id, g.name, ig.sort_order
           FROM item_genres ig
           JOIN genres g ON g.id = ig.genre_id
          WHERE ig.item_id = ANY($1::uuid[])
          ORDER BY ig.item_id, ig.sort_order, g.name`,
        [presentIds],
      ),
      pool.query<{
        item_id: string;
        name: string;
        role: string;
        character_name: string | null;
        sort_order: number;
        provider_ids: Record<string, string> | null;
      }>(
        `SELECT ip.item_id, p.name, ip.role, ip.character_name, ip.sort_order,
                p.provider_ids
           FROM item_people ip
           JOIN people p ON p.id = ip.person_id
          WHERE ip.item_id = ANY($1::uuid[])
          ORDER BY ip.item_id, ip.sort_order, p.name`,
        [presentIds],
      ),
    ]);

    const fileIds = files.rows.map((row) => row.id);
    const streams = fileIds.length
      ? await pool.query<{
          media_file_id: string;
          stream_index: number;
          kind: string;
          codec: string | null;
          language: string | null;
          is_default: boolean;
          is_forced: boolean;
          channels: number | null;
          width: number | null;
          height: number | null;
          bit_depth: number | null;
          video_range: string | null;
        }>(
          `SELECT media_file_id, stream_index, kind, codec, language,
                  is_default, is_forced, channels, width, height, bit_depth,
                  video_range
             FROM media_streams
            WHERE media_file_id = ANY($1::uuid[])
            ORDER BY media_file_id, stream_index`,
          [fileIds],
        )
      : { rows: [] };

    /*
     * One row per distinct directory, not per episode: a season with 24 files
     * in one folder answers "which folder" with a single row, and a season
     * spread over two folders is exactly the ambiguous case the planner has to
     * refuse.
     */
    const seasonDirectories = seasonIds.length
      ? await pool.query<{ season_id: string; directory: string }>(
          `SELECT child.parent_id AS season_id,
                  COALESCE(substring(mf.relative_path from '^(.*)/[^/]*$'), '')
                    AS directory
             FROM items child
             JOIN media_files mf
               ON mf.item_id = child.id AND mf.is_primary
            WHERE child.parent_id = ANY($1::uuid[])
              AND child.kind = 'episode'
              AND mf.missing_since IS NULL
            GROUP BY 1, 2
            ORDER BY 1, 2`,
          [seasonIds],
        )
      : { rows: [] };

    const filesByItem = groupBy(files.rows, (row) => row.item_id);
    const genresByItem = groupBy(genres.rows, (row) => row.item_id);
    const peopleByItem = groupBy(people.rows, (row) => row.item_id);
    const streamsByFile = groupBy(streams.rows, (row) => row.media_file_id);
    const directoriesBySeason = groupBy(
      seasonDirectories.rows,
      (row) => row.season_id,
    );

    return items.rows.map((row) => {
      const itemFiles = (filesByItem.get(row.id) ?? []).map((file) => ({
        id: file.id,
        itemId: file.item_id,
        relativePath: file.relative_path,
        container: file.container,
        durationMs: file.duration_ms,
        isPrimary: file.is_primary,
      }));

      const itemStreams = itemFiles.flatMap((file) =>
        (streamsByFile.get(file.id) ?? []).map((stream) => ({
          mediaFileId: stream.media_file_id,
          streamIndex: stream.stream_index,
          kind: stream.kind,
          codec: stream.codec,
          language: stream.language,
          isDefault: stream.is_default,
          isForced: stream.is_forced,
          channels: stream.channels,
          width: stream.width,
          height: stream.height,
          bitDepth: stream.bit_depth,
          videoRange: stream.video_range,
        })),
      );

      const seriesTitleRoot = row.series_source_key
        ? resolveTitleRoot({
            kind: "series",
            sourceKey: row.series_source_key,
            descendantRelativePath: row.series_descendant_relative_path,
          })
        : undefined;

      return {
        item: toItemRow(row),
        files: itemFiles,
        streams: itemStreams,
        genres: (genresByItem.get(row.id) ?? []).map((genre) => ({
          itemId: genre.item_id,
          name: genre.name,
          sortOrder: genre.sort_order,
        })),
        people: (peopleByItem.get(row.id) ?? []).map((person) => ({
          itemId: person.item_id,
          name: person.name,
          role: person.role,
          characterName: person.character_name,
          sortOrder: person.sort_order,
          providerIds: person.provider_ids ?? {},
        })),
        seriesTitle: row.series_title,
        seriesTitleRoot,
        descendantRelativePath: row.descendant_relative_path,
        seasonEpisodeDirectories: (directoriesBySeason.get(row.id) ?? []).map(
          (entry) => entry.directory,
        ),
      } satisfies NfoItemBundle;
    });
  }

  return {
    getLibrary: async (libraryId) => {
      const result = await pool.query<NfoLibrary>(
        `SELECT id, slug, name FROM libraries WHERE id = $1`,
        [libraryId],
      );
      return result.rows[0] ?? null;
    },

    getLibraryForItem: async (itemId) => {
      const result = await pool.query<NfoLibrary>(
        `SELECT l.id, l.slug, l.name
           FROM items i JOIN libraries l ON l.id = i.library_id
          WHERE i.id = $1`,
        [itemId],
      );
      return result.rows[0] ?? null;
    },

    listExportableItemIds: async (libraryId, { after, limit }) => {
      // Keyset by id: a library export walks the whole catalogue once, and an
      // offset would both slow down and skip rows as the scan mutates items.
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM items
          WHERE library_id = $1
            AND kind = ANY($2::text[])
            AND missing_since IS NULL
            AND ($3::uuid IS NULL OR id > $3::uuid)
          ORDER BY id
          LIMIT $4`,
        [libraryId, NFO_EXPORTABLE_KINDS, after ?? null, limit],
      );
      return result.rows.map((row) => row.id);
    },

    countExportableItems: async (libraryId) => {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM items
          WHERE library_id = $1
            AND kind = ANY($2::text[])
            AND missing_since IS NULL`,
        [libraryId, NFO_EXPORTABLE_KINDS],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    loadBundles: async (itemIds) => {
      const unique = [...new Set(itemIds)];
      if (unique.length === 0) return [];

      const bundles: NfoItemBundle[] = [];
      for (const ids of chunk(unique, ID_CHUNK)) {
        bundles.push(...(await loadChunk(ids)));
      }
      // Preserve the caller's order so a batched export is reproducible.
      const byId = new Map(bundles.map((bundle) => [bundle.item.id, bundle]));
      return unique
        .map((id) => byId.get(id))
        .filter((bundle): bundle is NfoItemBundle => bundle !== undefined);
    },
  };
}
