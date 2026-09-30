import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import { withTransaction } from "../database/transaction";

/**
 * The prefix of a provider-made collection's source key.
 *
 * Every other item's key is a path the scanner found; this one names a TMDB
 * collection instead, which is how the reconciler knows the item is not its
 * to retire when no folder turns up for it.
 */
export const PROVIDER_COLLECTION_KEY_PREFIX = "collection:tmdb:";

export interface ProviderCollection {
  providerId: string;
  name: string;
}

export interface CollectionRepository {
  /**
   * Puts a film in its provider collection, creating the collection in the
   * film's own library if this is its first member. Returns the collection's
   * item id.
   */
  attach(itemId: string, collection: ProviderCollection): Promise<string>;
  /** Takes a film out of whatever collection it was in; an emptied one goes. */
  detach(itemId: string): Promise<void>;
  /** Recounts every collection's available members. */
  refreshCounts(): Promise<void>;
}

function sortTitleOf(name: string): string {
  return name
    .replace(/^(the|a|an)\s+/i, "")
    .trim()
    .toLowerCase();
}

export function createCollectionRepository(
  pool: DatabasePool,
): CollectionRepository {
  async function refreshCounts(
    client: Pick<DatabasePool, "query">,
    collectionIds?: string[],
  ): Promise<void> {
    await client.query(
      `UPDATE items collection SET
         child_count = counts.total,
         recursive_item_count = counts.total,
         updated_at = now()
       FROM (
         SELECT parent.id, count(member.item_id)
           FILTER (WHERE film.missing_since IS NULL)::int AS total
         FROM items parent
         LEFT JOIN collection_members member ON member.collection_id = parent.id
         LEFT JOIN items film ON film.id = member.item_id
         WHERE parent.kind = 'collection'
           AND parent.source_key LIKE '${PROVIDER_COLLECTION_KEY_PREFIX}%'
           ${collectionIds ? "AND parent.id = ANY($1::uuid[])" : ""}
         GROUP BY parent.id
       ) counts
       WHERE collection.id = counts.id
         AND (collection.child_count, collection.recursive_item_count)
             IS DISTINCT FROM (counts.total, counts.total)`,
      collectionIds ? [collectionIds] : [],
    );
  }

  async function removeEmpty(
    client: Pick<DatabasePool, "query">,
    collectionIds: string[],
  ): Promise<void> {
    if (collectionIds.length === 0) return;
    await client.query(
      `DELETE FROM items collection
       WHERE collection.id = ANY($1::uuid[])
         AND collection.kind = 'collection'
         AND collection.source_key LIKE '${PROVIDER_COLLECTION_KEY_PREFIX}%'
         AND NOT EXISTS (
           SELECT 1 FROM collection_members member
           WHERE member.collection_id = collection.id
         )`,
      [collectionIds],
    );
  }

  return {
    attach: (itemId, collection) =>
      withTransaction(pool, async (client) => {
        const film = await client.query<{ library_id: string }>(
          `SELECT library_id FROM items WHERE id = $1 AND kind = 'movie'`,
          [itemId],
        );
        const libraryId = film.rows[0]?.library_id;
        if (!libraryId) {
          throw new Error("Only a film can join a collection.");
        }

        const sourceKey = `${PROVIDER_COLLECTION_KEY_PREFIX}${collection.providerId}`;
        const upserted = await client.query<{ id: string }>(
          `INSERT INTO items
             (id, library_id, kind, source_key, title, sort_title,
              provider_ids, metadata_state)
           VALUES ($1, $2, 'collection', $3, $4, $5, $6::jsonb, 'matched')
           ON CONFLICT (library_id, source_key) DO UPDATE SET
             title = CASE WHEN 'title' = ANY(items.locked_fields)
                          THEN items.title ELSE EXCLUDED.title END,
             sort_title = CASE WHEN 'title' = ANY(items.locked_fields)
                               THEN items.sort_title ELSE EXCLUDED.sort_title END,
             last_seen_at = now(),
             missing_since = NULL,
             updated_at = now()
           RETURNING id`,
          [
            randomUUID(),
            libraryId,
            sourceKey,
            collection.name,
            sortTitleOf(collection.name),
            JSON.stringify({ tmdb: collection.providerId }),
          ],
        );
        const collectionId = upserted.rows[0]!.id;

        const previous = await client.query<{ collection_id: string }>(
          `DELETE FROM collection_members
           WHERE item_id = $1 AND collection_id <> $2
           RETURNING collection_id`,
          [itemId, collectionId],
        );
        await client.query(
          `INSERT INTO collection_members (collection_id, item_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [collectionId, itemId],
        );
        const touched = [
          collectionId,
          ...previous.rows.map((row) => row.collection_id),
        ];
        await removeEmpty(
          client,
          previous.rows.map((row) => row.collection_id),
        );
        await refreshCounts(client, touched);
        return collectionId;
      }),

    detach: (itemId) =>
      withTransaction(pool, async (client) => {
        const removed = await client.query<{ collection_id: string }>(
          `DELETE FROM collection_members WHERE item_id = $1
           RETURNING collection_id`,
          [itemId],
        );
        const collectionIds = removed.rows.map((row) => row.collection_id);
        await removeEmpty(client, collectionIds);
        if (collectionIds.length > 0) {
          await refreshCounts(client, collectionIds);
        }
      }),

    refreshCounts: () => refreshCounts(pool),
  };
}
