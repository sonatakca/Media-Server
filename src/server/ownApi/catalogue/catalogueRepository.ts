import type { DatabasePool } from "../database/databasePool";

export type ItemKind =
  | "movie"
  | "series"
  | "season"
  | "episode"
  | "book"
  | "collection"
  | "trailer";

export interface CatalogueItemRow {
  id: string;
  libraryId: string;
  parentId: string | null;
  seriesId: string | null;
  kind: ItemKind;
  title: string;
  sortTitle: string;
  originalTitle: string | null;
  overview: string | null;
  tagline: string | null;
  productionYear: number | null;
  premiereDate: Date | null;
  officialRating: string | null;
  communityRating: number | null;
  runtimeMs: string | null;
  indexNumber: number | null;
  parentIndexNumber: number | null;
  providerIds: Record<string, string>;
  childCount: number;
  recursiveItemCount: number;
  dateCreated: Date;
  missingSince: Date | null;
  /** Fine logo placement on the card, or null when never adjusted. */
  logoLayout: { x: number; y: number; width: number } | null;
  seriesTitle: string | null;
  seasonTitle: string | null;
  genres: string[];
}

const ITEM_COLUMNS = `
  item.id,
  item.library_id,
  item.parent_id,
  item.series_id,
  item.kind,
  item.title,
  item.sort_title,
  item.original_title,
  item.overview,
  item.tagline,
  item.production_year,
  item.premiere_date,
  item.official_rating,
  item.community_rating,
  item.runtime_ms,
  item.index_number,
  item.parent_index_number,
  item.provider_ids,
  item.child_count,
  item.recursive_item_count,
  item.date_created,
  item.missing_since,
  item.logo_offset_x,
  item.logo_offset_y,
  item.logo_width,
  series.title AS series_title,
  season.title AS season_title,
  COALESCE(
    (
      SELECT array_agg(genre.name ORDER BY item_genre.sort_order)
      FROM item_genres item_genre
      JOIN genres genre ON genre.id = item_genre.genre_id
      WHERE item_genre.item_id = item.id
    ),
    ARRAY[]::varchar[]
  ) AS genres
`;

const ITEM_JOINS = `
  FROM items item
  LEFT JOIN items series ON series.id = item.series_id
  LEFT JOIN items season ON season.id = item.parent_id AND season.kind = 'season'
`;

interface RawItemRow extends Record<string, unknown> {
  id: string;
  library_id: string;
  parent_id: string | null;
  series_id: string | null;
  kind: ItemKind;
  title: string;
  sort_title: string;
  original_title: string | null;
  overview: string | null;
  tagline: string | null;
  production_year: number | null;
  premiere_date: Date | null;
  official_rating: string | null;
  community_rating: number | null;
  runtime_ms: string | null;
  index_number: number | null;
  parent_index_number: number | null;
  provider_ids: Record<string, string>;
  child_count: number;
  recursive_item_count: number;
  date_created: Date;
  missing_since: Date | null;
  logo_offset_x: number | null;
  logo_offset_y: number | null;
  logo_width: number | null;
  series_title: string | null;
  season_title: string | null;
  genres: string[];
}

function toItemRow(row: RawItemRow): CatalogueItemRow {
  return {
    id: row.id,
    libraryId: row.library_id,
    parentId: row.parent_id,
    seriesId: row.series_id,
    kind: row.kind,
    title: row.title,
    sortTitle: row.sort_title,
    originalTitle: row.original_title,
    overview: row.overview,
    tagline: row.tagline,
    productionYear: row.production_year,
    premiereDate: row.premiere_date,
    officialRating: row.official_rating,
    communityRating: row.community_rating,
    runtimeMs: row.runtime_ms,
    indexNumber: row.index_number,
    parentIndexNumber: row.parent_index_number,
    providerIds: row.provider_ids ?? {},
    childCount: row.child_count,
    recursiveItemCount: row.recursive_item_count,
    dateCreated: row.date_created,
    missingSince: row.missing_since,
    logoLayout:
      row.logo_offset_x === null ||
      row.logo_offset_y === null ||
      row.logo_width === null
        ? null
        : {
            x: row.logo_offset_x,
            y: row.logo_offset_y,
            width: row.logo_width,
          },
    seriesTitle: row.series_title,
    seasonTitle: row.season_title,
    genres: row.genres ?? [],
  };
}

export interface LibraryRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  sortOrder: number;
  itemCount: number;
}

export interface MediaFileRow {
  id: string;
  itemId: string;
  relativePath: string;
  container: string | null;
  sizeBytes: string;
  mtimeMs: string;
  fingerprint: string;
  durationMs: string | null;
  bitrateBps: string | null;
  isPrimary: boolean;
  probeState: "pending" | "probed" | "failed";
  missingSince: Date | null;
}

export interface MediaStreamRow {
  streamIndex: number;
  kind: "video" | "audio" | "subtitle" | "attachment" | "data";
  codec: string | null;
  profile: string | null;
  level: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  isExternal: boolean;
  isTextSubtitle: boolean;
  externalRelativePath: string | null;
  channels: number | null;
  sampleRate: number | null;
  bitrateBps: string | null;
  width: number | null;
  height: number | null;
  pixelFormat: string | null;
  frameRate: number | null;
  videoRange: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  colorSpace: string | null;
  bitDepth: number | null;
}

/**
 * Visibility rule shared by every catalogue read: a user sees a library when
 * they are allowed all libraries or hold an explicit grant. Applied inside SQL
 * rather than after the fact so that pagination totals and cursors stay correct.
 */
const LIBRARY_VISIBILITY_PREDICATE = `
  EXISTS (
    SELECT 1
    FROM libraries visible_library
    JOIN native_users viewer ON viewer.id = $1
    WHERE visible_library.id = item.library_id
      AND viewer.is_disabled = false
      AND (
        viewer.allow_all_libraries
        OR EXISTS (
          SELECT 1 FROM user_library_permissions grant_row
          WHERE grant_row.user_id = viewer.id
            AND grant_row.library_id = visible_library.id
        )
      )
  )
`;

/**
 * Read side of the catalogue. Scan-time writes live in `catalogueScanStore.ts`:
 * the two have colliding operation names (`listItems` over a user's visible
 * catalogue versus over a library's raw rows) and very different authorization
 * rules, so keeping them apart prevents a read path from accidentally reaching
 * an unfiltered query.
 */
export interface CatalogueRepository {
  listLibraries(userId: string): Promise<LibraryRow[]>;
  getLibrary(userId: string, libraryId: string): Promise<LibraryRow | null>;
  getItem(userId: string, itemId: string): Promise<CatalogueItemRow | null>;
  /** Batch variant; result order is unspecified, callers re-order as needed. */
  getItemsByIds(userId: string, itemIds: string[]): Promise<CatalogueItemRow[]>;
  listItems(options: ListItemsOptions): Promise<CatalogueItemRow[]>;
  listChildren(
    userId: string,
    parentId: string,
    kind: ItemKind,
  ): Promise<CatalogueItemRow[]>;
  listSeriesEpisodes(
    userId: string,
    seriesId: string,
  ): Promise<CatalogueItemRow[]>;
  searchItems(
    userId: string,
    query: string,
    limit: number,
  ): Promise<CatalogueItemRow[]>;
  listFilesForItem(itemId: string): Promise<MediaFileRow[]>;
  getPrimaryFile(itemId: string): Promise<MediaFileRow | null>;
  getFileById(fileId: string): Promise<MediaFileRow | null>;
  listStreams(mediaFileId: string): Promise<MediaStreamRow[]>;
  listChapters(itemId: string): Promise<Array<{ index: number; startMs: string; name: string | null }>>;
  listSegments(itemId: string): Promise<Array<{ id: string; type: string; startMs: string; endMs: string }>>;
  listPendingProbeFiles(limit: number): Promise<MediaFileRow[]>;
  listGenres(
    userId: string,
    libraryId?: string,
  ): Promise<Array<{ name: string; itemCount: number }>>;
  canUserAccessItem(userId: string, itemId: string): Promise<boolean>;
}

export interface ListItemsOptions {
  userId: string;
  libraryId?: string;
  kinds?: ItemKind[];
  parentId?: string;
  seriesId?: string;
  genre?: string;
  sort?: "title" | "dateCreated" | "premiereDate" | "communityRating" | "index";
  order?: "asc" | "desc";
  limit: number;
  cursor?: { key: string; id: string } | null;
  includeMissing?: boolean;
}

const SORT_COLUMNS: Record<
  NonNullable<ListItemsOptions["sort"]>,
  { expression: string; cursorKey: string }
> = {
  title: { expression: "item.sort_title", cursorKey: "sort_title" },
  dateCreated: { expression: "item.date_created", cursorKey: "date_created" },
  premiereDate: { expression: "item.premiere_date", cursorKey: "premiere_date" },
  communityRating: {
    expression: "item.community_rating",
    cursorKey: "community_rating",
  },
  index: {
    expression:
      "(COALESCE(item.parent_index_number, 0), COALESCE(item.index_number, 0))",
    cursorKey: "sort_title",
  },
};

export function createCatalogueRepository(
  pool: DatabasePool,
): CatalogueRepository {
  async function query<T extends Record<string, unknown>>(
    text: string,
    values: unknown[],
  ): Promise<T[]> {
    const result = await pool.query<T>(text, values);
    return result.rows;
  }

  async function selectItems(
    where: string,
    values: unknown[],
    orderBy: string,
    limit?: number,
  ): Promise<CatalogueItemRow[]> {
    const rows = await query<RawItemRow>(
      `SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE ${where} ORDER BY ${orderBy}${
        limit === undefined ? "" : ` LIMIT ${Math.trunc(limit)}`
      }`,
      values,
    );
    return rows.map(toItemRow);
  }

  return {
    // ---------------------------------------------------------------- reads

    listLibraries: async (userId) => {
      const rows = await query<{
        id: string;
        slug: string;
        name: string;
        kind: string;
        sort_order: number;
        item_count: string;
      }>(
        `SELECT
           library.id,
           library.slug,
           library.name,
           library.kind,
           library.sort_order,
           (
             SELECT count(*)
             FROM items counted
             WHERE counted.library_id = library.id
               AND counted.kind IN ('movie', 'series', 'book')
               AND counted.missing_since IS NULL
           ) AS item_count
         FROM libraries library
         JOIN native_users viewer ON viewer.id = $1
         WHERE viewer.is_disabled = false
           AND (
             viewer.allow_all_libraries
             OR EXISTS (
               SELECT 1 FROM user_library_permissions grant_row
               WHERE grant_row.user_id = viewer.id
                 AND grant_row.library_id = library.id
             )
           )
         ORDER BY library.sort_order, library.name`,
        [userId],
      );

      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        kind: row.kind,
        sortOrder: row.sort_order,
        itemCount: Number(row.item_count),
      }));
    },

    getLibrary: async (userId, libraryId) => {
      const rows = await query<{
        id: string;
        slug: string;
        name: string;
        kind: string;
        sort_order: number;
        item_count: string;
      }>(
        `SELECT
           library.id, library.slug, library.name, library.kind, library.sort_order,
           (
             SELECT count(*) FROM items counted
             WHERE counted.library_id = library.id
               AND counted.kind IN ('movie', 'series', 'book')
               AND counted.missing_since IS NULL
           ) AS item_count
         FROM libraries library
         JOIN native_users viewer ON viewer.id = $1
         WHERE library.id = $2
           AND viewer.is_disabled = false
           AND (
             viewer.allow_all_libraries
             OR EXISTS (
               SELECT 1 FROM user_library_permissions grant_row
               WHERE grant_row.user_id = viewer.id AND grant_row.library_id = library.id
             )
           )`,
        [userId, libraryId],
      );

      const row = rows[0];
      return row
        ? {
            id: row.id,
            slug: row.slug,
            name: row.name,
            kind: row.kind,
            sortOrder: row.sort_order,
            itemCount: Number(row.item_count),
          }
        : null;
    },

    getItem: async (userId, itemId) => {
      const rows = await selectItems(
        `item.id = $2 AND ${LIBRARY_VISIBILITY_PREDICATE}`,
        [userId, itemId],
        "item.sort_title",
        1,
      );
      return rows[0] ?? null;
    },

    getItemsByIds: async (userId, itemIds) => {
      if (itemIds.length === 0) return [];
      return selectItems(
        `item.id = ANY($2) AND ${LIBRARY_VISIBILITY_PREDICATE}`,
        [userId, itemIds],
        "item.sort_title",
      );
    },

    canUserAccessItem: async (userId, itemId) => {
      const rows = await query<{ allowed: boolean }>(
        `SELECT true AS allowed
         FROM items item
         WHERE item.id = $2 AND ${LIBRARY_VISIBILITY_PREDICATE}
         LIMIT 1`,
        [userId, itemId],
      );
      return rows.length > 0;
    },

    listItems: async ({
      userId,
      libraryId,
      kinds,
      parentId,
      seriesId,
      genre,
      sort = "title",
      order = "asc",
      limit,
      cursor,
      includeMissing = false,
    }) => {
      const values: unknown[] = [userId];
      const conditions = [LIBRARY_VISIBILITY_PREDICATE];

      if (!includeMissing) conditions.push("item.missing_since IS NULL");
      if (libraryId) {
        values.push(libraryId);
        conditions.push(`item.library_id = $${values.length}`);
      }
      if (kinds && kinds.length > 0) {
        values.push(kinds);
        conditions.push(`item.kind = ANY($${values.length})`);
      }
      if (parentId) {
        values.push(parentId);
        conditions.push(`item.parent_id = $${values.length}`);
      }
      if (seriesId) {
        values.push(seriesId);
        conditions.push(`item.series_id = $${values.length}`);
      }
      if (genre) {
        values.push(genre.toLowerCase());
        conditions.push(
          `EXISTS (
             SELECT 1 FROM item_genres ig
             JOIN genres g ON g.id = ig.genre_id
             WHERE ig.item_id = item.id AND g.normalized_name = $${values.length}
           )`,
        );
      }

      const sortColumn = SORT_COLUMNS[sort];
      const direction = order === "desc" ? "DESC" : "ASC";
      const comparison = order === "desc" ? "<" : ">";

      if (cursor) {
        // Keyset pagination: strictly after the last row in the sort order, with
        // the id as a tiebreaker so equal keys cannot repeat or be skipped.
        values.push(cursor.key, cursor.id);
        conditions.push(
          `(${sortColumn.expression}, item.id) ${comparison} ($${values.length - 1}, $${values.length})`,
        );
      }

      return selectItems(
        conditions.join(" AND "),
        values,
        `${sortColumn.expression} ${direction} NULLS LAST, item.id ${direction}`,
        limit,
      );
    },

    listChildren: async (userId, parentId, kind) =>
      selectItems(
        `item.parent_id = $2 AND item.kind = $3 AND item.missing_since IS NULL AND ${LIBRARY_VISIBILITY_PREDICATE}`,
        [userId, parentId, kind],
        "COALESCE(item.index_number, 0), item.sort_title",
      ),

    listSeriesEpisodes: async (userId, seriesId) =>
      selectItems(
        `item.series_id = $2 AND item.kind = 'episode' AND item.missing_since IS NULL AND ${LIBRARY_VISIBILITY_PREDICATE}`,
        [userId, seriesId],
        "COALESCE(item.parent_index_number, 0), COALESCE(item.index_number, 0)",
      ),

    searchItems: async (userId, searchQuery, limit) => {
      const pattern = `%${searchQuery.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`;
      return selectItems(
        `item.kind IN ('movie', 'series', 'episode', 'book')
         AND item.missing_since IS NULL
         AND (lower(item.title) LIKE $2 ESCAPE '\\' OR lower(COALESCE(item.original_title, '')) LIKE $2 ESCAPE '\\')
         AND ${LIBRARY_VISIBILITY_PREDICATE}`,
        [userId, pattern],
        // Prefix matches first, then alphabetical.
        `CASE WHEN lower(item.title) LIKE $2 ESCAPE '\\' THEN 0 ELSE 1 END, item.sort_title`,
        limit,
      );
    },

    listFilesForItem: async (itemId) => {
      const rows = await query<Record<string, never>>(
        `SELECT id, item_id, relative_path, container, size_bytes, mtime_ms,
                fingerprint, duration_ms, bitrate_bps, is_primary, probe_state, missing_since
         FROM media_files
         WHERE item_id = $1
         ORDER BY is_primary DESC, size_bytes DESC`,
        [itemId],
      );
      return rows.map(toMediaFileRow);
    },

    getPrimaryFile: async (itemId) => {
      const rows = await query<Record<string, never>>(
        `SELECT id, item_id, relative_path, container, size_bytes, mtime_ms,
                fingerprint, duration_ms, bitrate_bps, is_primary, probe_state, missing_since
         FROM media_files
         WHERE item_id = $1 AND missing_since IS NULL
         ORDER BY is_primary DESC, size_bytes DESC
         LIMIT 1`,
        [itemId],
      );
      const row = rows[0];
      return row ? toMediaFileRow(row) : null;
    },

    getFileById: async (fileId) => {
      const rows = await query<Record<string, never>>(
        `SELECT id, item_id, relative_path, container, size_bytes, mtime_ms,
                fingerprint, duration_ms, bitrate_bps, is_primary, probe_state, missing_since
         FROM media_files WHERE id = $1`,
        [fileId],
      );
      const row = rows[0];
      return row ? toMediaFileRow(row) : null;
    },

    listStreams: async (mediaFileId) => {
      const rows = await query<Record<string, never>>(
        `SELECT stream_index, kind, codec, profile, level, language, title,
                is_default, is_forced, is_external, is_text_subtitle, external_relative_path,
                channels, sample_rate, bitrate_bps, width, height, pixel_format,
                frame_rate, video_range, color_transfer, color_primaries, color_space, bit_depth
         FROM media_streams WHERE media_file_id = $1 ORDER BY stream_index`,
        [mediaFileId],
      );
      return rows.map(toMediaStreamRow);
    },

    listChapters: async (itemId) => {
      const rows = await query<{
        chapter_index: number;
        start_ms: string;
        name: string | null;
      }>(
        `SELECT chapter_index, start_ms, name FROM item_chapters
         WHERE item_id = $1 ORDER BY chapter_index`,
        [itemId],
      );
      return rows.map((row) => ({
        index: row.chapter_index,
        startMs: row.start_ms,
        name: row.name,
      }));
    },

    listSegments: async (itemId) => {
      const rows = await query<{
        id: string;
        segment_type: string;
        start_ms: string;
        end_ms: string;
      }>(
        `SELECT id, segment_type, start_ms, end_ms FROM item_segments
         WHERE item_id = $1 ORDER BY start_ms`,
        [itemId],
      );
      return rows.map((row) => ({
        id: row.id,
        type: row.segment_type,
        startMs: row.start_ms,
        endMs: row.end_ms,
      }));
    },

    listGenres: async (userId, libraryId) => {
      const values: unknown[] = [userId];
      let libraryFilter = "";
      if (libraryId) {
        values.push(libraryId);
        libraryFilter = `AND item.library_id = $${values.length}`;
      }

      const rows = await query<{ name: string; item_count: string }>(
        `SELECT genre.name, count(*) AS item_count
         FROM item_genres item_genre
         JOIN genres genre ON genre.id = item_genre.genre_id
         JOIN items item ON item.id = item_genre.item_id
         WHERE item.missing_since IS NULL
           AND item.kind IN ('movie', 'series', 'book')
           ${libraryFilter}
           AND ${LIBRARY_VISIBILITY_PREDICATE}
         GROUP BY genre.name
         ORDER BY genre.name`,
        values,
      );
      return rows.map((row) => ({
        name: row.name,
        itemCount: Number(row.item_count),
      }));
    },

    listPendingProbeFiles: async (limit) => {
      const rows = await query<Record<string, never>>(
        `SELECT id, item_id, relative_path, container, size_bytes, mtime_ms,
                fingerprint, duration_ms, bitrate_bps, is_primary, probe_state, missing_since
         FROM media_files
         WHERE probe_state = 'pending' AND missing_since IS NULL
         ORDER BY is_primary DESC, created_at
         LIMIT $1`,
        [limit],
      );
      return rows.map(toMediaFileRow);
    },
  };
}

function toMediaFileRow(row: Record<string, unknown>): MediaFileRow {
  return {
    id: row.id as string,
    itemId: row.item_id as string,
    relativePath: row.relative_path as string,
    container: (row.container as string | null) ?? null,
    sizeBytes: String(row.size_bytes),
    mtimeMs: String(row.mtime_ms),
    fingerprint: row.fingerprint as string,
    durationMs: row.duration_ms === null ? null : String(row.duration_ms),
    bitrateBps: row.bitrate_bps === null ? null : String(row.bitrate_bps),
    isPrimary: row.is_primary as boolean,
    probeState: row.probe_state as MediaFileRow["probeState"],
    missingSince: (row.missing_since as Date | null) ?? null,
  };
}

function toMediaStreamRow(row: Record<string, unknown>): MediaStreamRow {
  return {
    streamIndex: row.stream_index as number,
    kind: row.kind as MediaStreamRow["kind"],
    codec: (row.codec as string | null) ?? null,
    profile: (row.profile as string | null) ?? null,
    level: (row.level as number | null) ?? null,
    language: (row.language as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    isDefault: row.is_default as boolean,
    isForced: row.is_forced as boolean,
    isExternal: row.is_external as boolean,
    isTextSubtitle: row.is_text_subtitle as boolean,
    externalRelativePath: (row.external_relative_path as string | null) ?? null,
    channels: (row.channels as number | null) ?? null,
    sampleRate: (row.sample_rate as number | null) ?? null,
    bitrateBps: row.bitrate_bps === null ? null : String(row.bitrate_bps),
    width: (row.width as number | null) ?? null,
    height: (row.height as number | null) ?? null,
    pixelFormat: (row.pixel_format as string | null) ?? null,
    frameRate: (row.frame_rate as number | null) ?? null,
    videoRange: (row.video_range as string | null) ?? null,
    colorTransfer: (row.color_transfer as string | null) ?? null,
    colorPrimaries: (row.color_primaries as string | null) ?? null,
    colorSpace: (row.color_space as string | null) ?? null,
    bitDepth: (row.bit_depth as number | null) ?? null,
  };
}

