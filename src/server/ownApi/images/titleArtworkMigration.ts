import { readFile } from "node:fs/promises";
import type { DatabasePool } from "../database/databasePool";
import type { ImageStorage, TitleArtworkType } from "./imageStorage";

interface LegacyArtworkRow {
  id: string;
  kind: string;
  source_key: string;
  primary_relative_path: string | null;
  image_type: TitleArtworkType;
  content_type: string;
  storage_key: string;
}

export interface TitleArtworkMigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
}

function titleRootFor(row: LegacyArtworkRow): string | undefined {
  const prefix = `${row.kind}:`;
  if (!row.source_key.startsWith(prefix)) return undefined;
  const candidate = row.source_key.slice(prefix.length);
  if (!candidate) return undefined;
  if (row.kind === "series") return candidate;
  if (
    row.kind === "movie" &&
    row.primary_relative_path?.startsWith(`${candidate}/`)
  ) {
    return candidate;
  }
  return undefined;
}

/**
 * Copies legacy content-addressed originals into each title's canonical
 * content/ directory and then repoints the catalogue row.
 *
 * This is intentionally a copy, not a rename: content-addressed bytes may be
 * shared by several items. Once every row has moved, the old cache can be
 * cleaned independently without ever risking another title's artwork.
 */
export async function migrateTitleArtwork(
  pool: Pick<DatabasePool, "query">,
  imageStorage: ImageStorage,
): Promise<TitleArtworkMigrationResult> {
  const result = await pool.query<LegacyArtworkRow>(
    `SELECT item_images.id, items.kind, items.source_key,
            item_images.image_type, item_images.content_type,
            item_images.storage_key,
            (SELECT relative_path FROM media_files
             WHERE media_files.item_id = items.id
               AND media_files.is_primary = true
             ORDER BY media_files.created_at LIMIT 1) AS primary_relative_path
     FROM item_images
     JOIN items ON items.id = item_images.item_id
     WHERE item_images.image_type IN ('cover', 'backdrop', 'logo')
       AND item_images.image_index = 0
       AND item_images.storage_key NOT LIKE 'media:%'
     ORDER BY item_images.id`,
  );

  const summary: TitleArtworkMigrationResult = {
    migrated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const row of result.rows) {
    const titleRoot = titleRootFor(row);
    if (!titleRoot) {
      summary.skipped += 1;
      continue;
    }

    try {
      const bytes = await readFile(imageStorage.resolve(row.storage_key));
      const stored = await imageStorage.storeTitleArtwork(
        bytes,
        row.content_type,
        titleRoot,
        row.image_type,
      );
      const updated = await pool.query(
        `UPDATE item_images SET
           content_hash = $2,
           content_type = $3,
           size_bytes = $4,
           storage_key = $5
         WHERE id = $1 AND storage_key = $6`,
        [
          row.id,
          stored.contentHash,
          stored.contentType,
          stored.sizeBytes,
          stored.storageKey,
          row.storage_key,
        ],
      );
      if ((updated.rowCount ?? 0) > 0) summary.migrated += 1;
      else summary.skipped += 1;
    } catch {
      // One unreadable legacy image must not make the entire media server
      // unavailable. Its row still points at the old, servable location and a
      // later metadata refresh can replace it.
      summary.failed += 1;
    }
  }

  return summary;
}
