import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import type { ScannedSubtitle } from "../scanner/libraryScan";
import type {
  CatalogueScanStore,
  ExistingFileRow,
  ExistingItemRow,
  UpsertFileInput,
  UpsertItemInput,
} from "../scanner/reconciler";

/**
 * Scan-time write side of the catalogue.
 *
 * Every statement is written so that re-running an unchanged scan produces no
 * observable change: upserts are keyed on the scanner's stable source key or
 * relative path, and locked fields are preserved by the SQL itself rather than
 * by a read-modify-write that could race a concurrent metadata edit.
 */
export function createCatalogueScanStore(
  pool: DatabasePool,
): CatalogueScanStore {
  return {
    listItems: async (libraryId) => {
      const result = await pool.query<{
        id: string;
        source_key: string;
        kind: string;
        locked_fields: string[];
        missing_since: Date | null;
      }>(
        `SELECT id, source_key, kind, locked_fields, missing_since
         FROM items WHERE library_id = $1`,
        [libraryId],
      );
      return result.rows.map<ExistingItemRow>((row) => ({
        id: row.id,
        sourceKey: row.source_key,
        kind: row.kind,
        lockedFields: row.locked_fields ?? [],
        missingSince: row.missing_since,
      }));
    },

    listFiles: async (libraryId) => {
      const result = await pool.query<{
        id: string;
        item_id: string;
        relative_path: string;
        fingerprint: string;
        missing_since: Date | null;
      }>(
        `SELECT file.id, file.item_id, file.relative_path, file.fingerprint, file.missing_since
         FROM media_files file
         JOIN items item ON item.id = file.item_id
         WHERE item.library_id = $1`,
        [libraryId],
      );
      return result.rows.map<ExistingFileRow>((row) => ({
        id: row.id,
        itemId: row.item_id,
        relativePath: row.relative_path,
        fingerprint: row.fingerprint,
        missingSince: row.missing_since,
      }));
    },

    upsertItem: async (input: UpsertItemInput) => {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO items (
           id, library_id, source_key, kind, title, sort_title,
           production_year, index_number, parent_index_number, last_seen_at, missing_since
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULL)
         ON CONFLICT (library_id, source_key) DO UPDATE SET
           -- A locked field keeps the curated value; everything else follows disk.
           title = CASE WHEN 'title' = ANY(items.locked_fields)
                        THEN items.title ELSE EXCLUDED.title END,
           sort_title = CASE WHEN 'title' = ANY(items.locked_fields)
                        THEN items.sort_title ELSE EXCLUDED.sort_title END,
           production_year = CASE WHEN 'productionYear' = ANY(items.locked_fields)
                        THEN items.production_year
                        ELSE COALESCE(EXCLUDED.production_year, items.production_year) END,
           index_number = COALESCE(EXCLUDED.index_number, items.index_number),
           parent_index_number = COALESCE(EXCLUDED.parent_index_number, items.parent_index_number),
           last_seen_at = now(),
           missing_since = NULL,
           updated_at = now()
         RETURNING id`,
        [
          randomUUID(),
          input.libraryId,
          input.sourceKey,
          input.kind,
          input.title,
          input.sortTitle,
          input.year ?? null,
          input.indexNumber ?? null,
          input.parentIndexNumber ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Item upsert returned no row.");
      return row.id;
    },

    setItemRelations: async (itemId, { parentId, seriesId }) => {
      await pool.query(
        `UPDATE items SET parent_id = $2, series_id = $3, updated_at = now()
         WHERE id = $1
           AND (parent_id IS DISTINCT FROM $2 OR series_id IS DISTINCT FROM $3)`,
        [itemId, parentId, seriesId],
      );
    },

    upsertFile: async (input: UpsertFileInput) => {
      const result = await pool.query<{ id: string; changed: boolean }>(
        `INSERT INTO media_files (
           id, item_id, relative_path, container, size_bytes, mtime_ms,
           fingerprint, is_primary, probe_state, last_seen_at, missing_since
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', now(), NULL)
         ON CONFLICT (relative_path) DO UPDATE SET
           item_id = EXCLUDED.item_id,
           container = EXCLUDED.container,
           size_bytes = EXCLUDED.size_bytes,
           mtime_ms = EXCLUDED.mtime_ms,
           fingerprint = EXCLUDED.fingerprint,
           is_primary = EXCLUDED.is_primary,
           -- Only a genuine content change invalidates the stored probe.
           probe_state = CASE WHEN media_files.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
                              THEN 'pending' ELSE media_files.probe_state END,
           last_seen_at = now(),
           missing_since = NULL,
           updated_at = now()
         RETURNING id, (xmax = 0 OR media_files.probe_state = 'pending') AS changed`,
        [
          randomUUID(),
          input.itemId,
          input.relativePath,
          input.container || null,
          input.size,
          Math.trunc(input.mtimeMs),
          input.fingerprint,
          input.isPrimary,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Media file upsert returned no row.");
      return { id: row.id, changed: row.changed };
    },

    replaceExternalSubtitles: async (
      itemId: string,
      subtitles: ScannedSubtitle[],
    ) => {
      const fileResult = await pool.query<{ id: string }>(
        `SELECT id FROM media_files WHERE item_id = $1 ORDER BY is_primary DESC LIMIT 1`,
        [itemId],
      );
      const mediaFileId = fileResult.rows[0]?.id;
      if (!mediaFileId) return;

      await pool.query(
        `DELETE FROM media_streams WHERE media_file_id = $1 AND is_external = true`,
        [mediaFileId],
      );

      // External subtitles occupy a high index range so they cannot collide with
      // the container's own stream indexes.
      let externalIndex = 10_000;
      for (const subtitle of subtitles) {
        await pool.query(
          `INSERT INTO media_streams (
             media_file_id, stream_index, kind, language, is_default, is_forced,
             is_external, is_text_subtitle, external_relative_path
           )
           VALUES ($1, $2, 'subtitle', $3, $4, $5, true, true, $6)
           ON CONFLICT (media_file_id, stream_index) DO NOTHING`,
          [
            mediaFileId,
            externalIndex,
            subtitle.language ?? null,
            subtitle.isDefault,
            subtitle.isForced,
            subtitle.relativePath,
          ],
        );
        externalIndex += 1;
      }
    },

    markItemsSeen: async (itemIds) => {
      if (itemIds.length === 0) return;
      await pool.query(
        `UPDATE items SET last_seen_at = now(), missing_since = NULL
         WHERE id = ANY($1) AND missing_since IS NOT NULL`,
        [itemIds],
      );
    },

    markFilesSeen: async (fileIds) => {
      if (fileIds.length === 0) return;
      await pool.query(
        `UPDATE media_files SET last_seen_at = now(), missing_since = NULL
         WHERE id = ANY($1) AND missing_since IS NOT NULL`,
        [fileIds],
      );
    },

    markItemsMissing: async (itemIds, missingSince) => {
      if (itemIds.length === 0) return;
      await pool.query(
        `UPDATE items SET missing_since = $2 WHERE id = ANY($1) AND missing_since IS NULL`,
        [itemIds, missingSince],
      );
    },

    markFilesMissing: async (fileIds, missingSince) => {
      if (fileIds.length === 0) return;
      await pool.query(
        `UPDATE media_files SET missing_since = $2 WHERE id = ANY($1) AND missing_since IS NULL`,
        [fileIds, missingSince],
      );
    },

    deleteItems: async (itemIds) => {
      if (itemIds.length === 0) return;
      await pool.query(`DELETE FROM items WHERE id = ANY($1)`, [itemIds]);
    },

    deleteFiles: async (fileIds) => {
      if (fileIds.length === 0) return;
      await pool.query(`DELETE FROM media_files WHERE id = ANY($1)`, [fileIds]);
    },

    queueProbe: async (fileIds) => {
      if (fileIds.length === 0) return;
      await pool.query(
        `UPDATE media_files SET probe_state = 'pending', probe_error = NULL
         WHERE id = ANY($1)`,
        [fileIds],
      );
    },

    refreshItemCounts: async (libraryId) => {
      // A LATERAL subquery in UPDATE ... FROM cannot reference the update
      // target, so the counts are computed over the whole library first and
      // joined back by id. The LEFT JOIN is what makes an emptied season reset
      // to zero: a plain grouped join would produce no row for it at all.
      await pool.query(
        `UPDATE items season SET
           child_count = counts.total,
           recursive_item_count = counts.total,
           updated_at = now()
         FROM (
           SELECT parent.id, count(episode.id)::int AS total
           FROM items parent
           LEFT JOIN items episode
             ON episode.parent_id = parent.id
            AND episode.kind = 'episode'
            AND episode.missing_since IS NULL
           WHERE parent.kind = 'season' AND parent.library_id = $1
           GROUP BY parent.id
         ) counts
         WHERE season.id = counts.id
           AND (season.child_count, season.recursive_item_count)
               IS DISTINCT FROM (counts.total, counts.total)`,
        [libraryId],
      );

      await pool.query(
        `UPDATE items series SET
           child_count = counts.season_total,
           recursive_item_count = counts.episode_total,
           updated_at = now()
         FROM (
           SELECT
             parent.id,
             count(DISTINCT season.id)::int AS season_total,
             count(DISTINCT episode.id)::int AS episode_total
           FROM items parent
           LEFT JOIN items season
             ON season.parent_id = parent.id
            AND season.kind = 'season'
            AND season.missing_since IS NULL
           LEFT JOIN items episode
             ON episode.series_id = parent.id
            AND episode.kind = 'episode'
            AND episode.missing_since IS NULL
           WHERE parent.kind = 'series' AND parent.library_id = $1
           GROUP BY parent.id
         ) counts
         WHERE series.id = counts.id
           AND (series.child_count, series.recursive_item_count)
               IS DISTINCT FROM (counts.season_total, counts.episode_total)`,
        [libraryId],
      );
    },
  };
}
