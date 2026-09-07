import { randomUUID } from "node:crypto";
import { LIBRARY_VISIBILITY_PREDICATE } from "../catalogue/catalogueRepository";
import type { DatabasePool } from "../database/databasePool";
import { withTransaction } from "../database/transaction";

/**
 * The shelves that can carry a hand-placed order.
 *
 * The list is closed, and deliberately so: a surface name is half of a list's
 * identity, so an unrecognised one would create an ordering that no page reads
 * and no editor shows.
 */
export const CURATED_SURFACES = ["home-hero", "library"] as const;

export type CuratedSurface = (typeof CURATED_SURFACES)[number];

/** The only surface scoped to a library; the hero carousel exists once. */
export const LIBRARY_SCOPED_SURFACE: CuratedSurface = "library";

export interface CuratedListKey {
  surface: CuratedSurface;
  /** Required for `library`, rejected for every other surface. */
  libraryId?: string | undefined;
}

export interface CuratedEntry {
  itemId: string;
  /**
   * Keeps the title off the home page — its Latest row, or the carousel.
   * A library grid ignores it: hiding a title from its own library would make
   * it unreachable rather than unobtrusive.
   */
  hidden: boolean;
}

export interface CuratedList extends CuratedListKey {
  entries: CuratedEntry[];
  updatedAt: Date | null;
}

export interface CurationRepository {
  /** An unsaved list reads as empty rather than missing: no order is an order. */
  get(key: CuratedListKey): Promise<CuratedList>;
  /**
   * Replaces the whole list in one transaction.
   *
   * Whole-list replacement rather than per-entry edits because the thing being
   * stored is a sequence: a partially applied reorder is not a smaller change,
   * it is a different and wrong order.
   */
  replace(
    key: CuratedListKey,
    entries: CuratedEntry[],
    updatedBy: string | null,
  ): Promise<void>;
  /** Drops the ordering, returning the shelf to its default sort. */
  clear(key: CuratedListKey): Promise<void>;
  /** Which of the given item ids exist, so a save can reject unknown ones. */
  filterExistingItemIds(itemIds: string[]): Promise<Set<string>>;
  /**
   * Which of the given item ids the user is allowed to see.
   *
   * A stored ordering is house-wide, but reading one must not hand a user the
   * ids of titles in a library they were never granted: an id they cannot
   * fetch is still an id they should not learn.
   */
  filterVisibleItemIds(userId: string, itemIds: string[]): Promise<Set<string>>;
  libraryExists(libraryId: string): Promise<boolean>;
}

export function createCurationRepository(
  pool: DatabasePool,
): CurationRepository {
  /*
   * `library_id IS NOT DISTINCT FROM $2` rather than `= $2`, because the home
   * surfaces store NULL there and `NULL = NULL` is NULL, not true. Every lookup
   * in this file goes through the same predicate so the two shapes cannot drift
   * apart.
   */
  const LIST_PREDICATE = "surface = $1 AND library_id IS NOT DISTINCT FROM $2";

  function keyValues(key: CuratedListKey): [string, string | null] {
    return [key.surface, key.libraryId ?? null];
  }

  return {
    get: async (key) => {
      const listRows = await pool.query<{ id: string; updated_at: Date }>(
        `SELECT id, updated_at FROM curated_lists WHERE ${LIST_PREDICATE}`,
        keyValues(key),
      );
      const list = listRows.rows[0];

      if (!list) {
        return { ...key, entries: [], updatedAt: null };
      }

      const entryRows = await pool.query<{ item_id: string; hidden: boolean }>(
        `SELECT item_id, hidden FROM curated_list_entries
         WHERE list_id = $1 ORDER BY position`,
        [list.id],
      );

      return {
        ...key,
        updatedAt: list.updated_at,
        entries: entryRows.rows.map((row) => ({
          itemId: row.item_id,
          hidden: row.hidden,
        })),
      };
    },

    replace: async (key, entries, updatedBy) => {
      await withTransaction(pool, async (client) => {
        const values = keyValues(key);
        /*
         * Upsert-by-select rather than ON CONFLICT: the uniqueness is carried by
         * two partial indexes, and ON CONFLICT cannot name a predicate that
         * covers both shapes. Inside a transaction the read and the insert are
         * one step, and the indexes still refuse a duplicate if two saves race.
         */
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM curated_lists WHERE ${LIST_PREDICATE} FOR UPDATE`,
          values,
        );

        let listId = existing.rows[0]?.id;

        if (listId) {
          await client.query(
            `UPDATE curated_lists SET updated_at = now(), updated_by = $2
             WHERE id = $1`,
            [listId, updatedBy],
          );
          // The old sequence goes before the new one lands: rewriting in place
          // would collide with the dense-position index part-way through.
          await client.query(
            "DELETE FROM curated_list_entries WHERE list_id = $1",
            [listId],
          );
        } else {
          listId = randomUUID();
          await client.query(
            `INSERT INTO curated_lists (id, surface, library_id, updated_by)
             VALUES ($1, $2, $3, $4)`,
            [listId, key.surface, key.libraryId ?? null, updatedBy],
          );
        }

        if (entries.length === 0) return;

        // One statement rather than a loop: a hundred round trips inside a
        // transaction is a hundred chances to hold the row locks longer.
        await client.query(
          `INSERT INTO curated_list_entries (list_id, item_id, position, hidden)
           SELECT $1, entry.item_id, entry.position, entry.hidden
           FROM UNNEST($2::uuid[], $3::int[], $4::boolean[])
             AS entry(item_id, position, hidden)`,
          [
            listId,
            entries.map((entry) => entry.itemId),
            entries.map((_, index) => index),
            entries.map((entry) => entry.hidden),
          ],
        );
      });
    },

    clear: async (key) => {
      // The entries cascade from the list row, so one delete is the whole of it.
      await pool.query(
        `DELETE FROM curated_lists WHERE ${LIST_PREDICATE}`,
        keyValues(key),
      );
    },

    filterExistingItemIds: async (itemIds) => {
      if (itemIds.length === 0) return new Set<string>();

      const rows = await pool.query<{ id: string }>(
        "SELECT id FROM items WHERE id = ANY($1::uuid[])",
        [itemIds],
      );
      return new Set(rows.rows.map((row) => row.id));
    },

    filterVisibleItemIds: async (userId, itemIds) => {
      if (itemIds.length === 0) return new Set<string>();

      // The catalogue's own predicate, imported rather than restated: one
      // visibility rule with two spellings is one rule that will eventually
      // disagree with itself.
      const rows = await pool.query<{ id: string }>(
        `SELECT item.id FROM items item
         WHERE item.id = ANY($2::uuid[]) AND ${LIBRARY_VISIBILITY_PREDICATE}`,
        [userId, itemIds],
      );
      return new Set(rows.rows.map((row) => row.id));
    },

    libraryExists: async (libraryId) => {
      const rows = await pool.query<{ id: string }>(
        "SELECT id FROM libraries WHERE id = $1",
        [libraryId],
      );
      return rows.rows.length > 0;
    },
  };
}
