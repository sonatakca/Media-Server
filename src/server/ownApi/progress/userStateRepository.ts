import type { DatabasePool } from "../database/databasePool";
import type { UserStateRecord } from "../catalogue/itemDto";

export interface ProgressUpdate {
  userId: string;
  itemId: string;
  positionMs: number;
  /**
   * Client-supplied monotonic counter. A write whose sequence is not greater
   * than the stored one is ignored, so a delayed retry from a backgrounded tab
   * cannot rewind a position the user has since moved past.
   */
  sequence: number;
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | null;
}

export interface UserStateRepository {
  getMany(userId: string, itemIds: string[]): Promise<Map<string, UserStateRecord>>;
  get(userId: string, itemId: string): Promise<UserStateRecord | null>;
  /** Returns false when the write was rejected as stale. */
  updateProgress(update: ProgressUpdate): Promise<boolean>;
  setPlayed(userId: string, itemId: string, played: boolean): Promise<void>;
  setFavourite(userId: string, itemId: string, isFavourite: boolean): Promise<void>;
  incrementPlayCount(userId: string, itemId: string): Promise<void>;
  /** Clears progress and played state for an item and everything beneath it. */
  resetWatchedRecursively(userId: string, itemId: string): Promise<number>;
  /** Marks an item and everything beneath it played. */
  markWatchedRecursively(userId: string, itemId: string): Promise<number>;
  listResumable(
    userId: string,
    limit: number,
  ): Promise<Array<{ itemId: string; lastPlayedAt: Date }>>;
  listFavourites(userId: string, limit: number): Promise<string[]>;
}

const STATE_COLUMNS = `
  item_id, position_ms, played, play_count, is_favourite,
  last_played_at, audio_stream_index, subtitle_stream_index
`;

interface RawStateRow {
  item_id: string;
  position_ms: string;
  played: boolean;
  play_count: number;
  is_favourite: boolean;
  last_played_at: Date | null;
  audio_stream_index: number | null;
  subtitle_stream_index: number | null;
}

function toRecord(row: RawStateRow): UserStateRecord {
  return {
    itemId: row.item_id,
    positionMs: row.position_ms,
    played: row.played,
    playCount: row.play_count,
    isFavourite: row.is_favourite,
    lastPlayedAt: row.last_played_at,
    audioStreamIndex: row.audio_stream_index,
    subtitleStreamIndex: row.subtitle_stream_index,
  };
}

/**
 * Descendants of an item: seasons and episodes of a series, episodes of a
 * season, or the item itself. Used by the recursive watched operations so that
 * "mark series watched" does not require the client to enumerate episodes.
 */
const DESCENDANT_ITEMS = `
  WITH RECURSIVE descendants AS (
    SELECT id FROM items WHERE id = $2
    UNION ALL
    SELECT child.id FROM items child
    JOIN descendants ON child.parent_id = descendants.id
  )
  SELECT id FROM descendants
`;

export function createUserStateRepository(
  pool: DatabasePool,
): UserStateRepository {
  return {
    getMany: async (userId, itemIds) => {
      const states = new Map<string, UserStateRecord>();
      if (itemIds.length === 0) return states;

      const result = await pool.query<RawStateRow>(
        `SELECT ${STATE_COLUMNS} FROM user_item_state
         WHERE user_id = $1 AND item_id = ANY($2)`,
        [userId, itemIds],
      );
      for (const row of result.rows) {
        states.set(row.item_id, toRecord(row));
      }
      return states;
    },

    get: async (userId, itemId) => {
      const result = await pool.query<RawStateRow>(
        `SELECT ${STATE_COLUMNS} FROM user_item_state
         WHERE user_id = $1 AND item_id = $2`,
        [userId, itemId],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    updateProgress: async ({
      userId,
      itemId,
      positionMs,
      sequence,
      audioStreamIndex,
      subtitleStreamIndex,
    }) => {
      const result = await pool.query(
        `INSERT INTO user_item_state (
           user_id, item_id, position_ms, progress_sequence, last_played_at,
           audio_stream_index, subtitle_stream_index, updated_at
         )
         VALUES ($1, $2, $3, $4, now(), $5, $6, now())
         ON CONFLICT (user_id, item_id) DO UPDATE SET
           position_ms = EXCLUDED.position_ms,
           progress_sequence = EXCLUDED.progress_sequence,
           last_played_at = now(),
           audio_stream_index = COALESCE(EXCLUDED.audio_stream_index, user_item_state.audio_stream_index),
           subtitle_stream_index = COALESCE(EXCLUDED.subtitle_stream_index, user_item_state.subtitle_stream_index),
           updated_at = now()
         WHERE EXCLUDED.progress_sequence > user_item_state.progress_sequence`,
        [
          userId,
          itemId,
          Math.max(0, Math.trunc(positionMs)),
          Math.trunc(sequence),
          audioStreamIndex ?? null,
          subtitleStreamIndex ?? null,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    },

    setPlayed: async (userId, itemId, played) => {
      await pool.query(
        `INSERT INTO user_item_state (
           user_id, item_id, played, position_ms, play_count, last_played_at, updated_at
         )
         VALUES ($1, $2, $3, 0, CASE WHEN $3 THEN 1 ELSE 0 END,
                 CASE WHEN $3 THEN now() ELSE NULL END, now())
         ON CONFLICT (user_id, item_id) DO UPDATE SET
           played = $3,
           -- Marking played clears the resume position; unmarking leaves it be
           -- so an accidental toggle does not lose the user's place.
           position_ms = CASE WHEN $3 THEN 0 ELSE user_item_state.position_ms END,
           play_count = CASE
             WHEN $3 AND user_item_state.played = false
               THEN user_item_state.play_count + 1
             ELSE user_item_state.play_count END,
           last_played_at = CASE WHEN $3 THEN now() ELSE user_item_state.last_played_at END,
           updated_at = now()`,
        [userId, itemId, played],
      );
    },

    setFavourite: async (userId, itemId, isFavourite) => {
      await pool.query(
        `INSERT INTO user_item_state (user_id, item_id, is_favourite, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, item_id) DO UPDATE SET
           is_favourite = $3, updated_at = now()`,
        [userId, itemId, isFavourite],
      );
    },

    incrementPlayCount: async (userId, itemId) => {
      await pool.query(
        `INSERT INTO user_item_state (user_id, item_id, play_count, last_played_at, updated_at)
         VALUES ($1, $2, 1, now(), now())
         ON CONFLICT (user_id, item_id) DO UPDATE SET
           play_count = user_item_state.play_count + 1,
           last_played_at = now(),
           updated_at = now()`,
        [userId, itemId],
      );
    },

    resetWatchedRecursively: async (userId, itemId) => {
      const result = await pool.query(
        `UPDATE user_item_state SET
           played = false,
           position_ms = 0,
           last_played_at = NULL,
           progress_sequence = user_item_state.progress_sequence + 1,
           updated_at = now()
         WHERE user_id = $1 AND item_id IN (${DESCENDANT_ITEMS})`,
        [userId, itemId],
      );
      return result.rowCount ?? 0;
    },

    markWatchedRecursively: async (userId, itemId) => {
      const result = await pool.query(
        `INSERT INTO user_item_state (
           user_id, item_id, played, position_ms, play_count, last_played_at, updated_at
         )
         SELECT $1, descendant.id, true, 0, 1, now(), now()
         FROM (${DESCENDANT_ITEMS}) descendant
         JOIN items target ON target.id = descendant.id
         -- Containers have no playable position of their own; marking the
         -- leaves watched is what the UI reflects upward.
         WHERE target.kind IN ('movie', 'episode', 'book')
         ON CONFLICT (user_id, item_id) DO UPDATE SET
           played = true,
           position_ms = 0,
           play_count = GREATEST(user_item_state.play_count, 1),
           last_played_at = now(),
           updated_at = now()`,
        [userId, itemId],
      );
      return result.rowCount ?? 0;
    },

    listResumable: async (userId, limit) => {
      const result = await pool.query<{ item_id: string; last_played_at: Date }>(
        `SELECT state.item_id, state.last_played_at
         FROM user_item_state state
         JOIN items item ON item.id = state.item_id
         WHERE state.user_id = $1
           AND state.played = false
           AND state.position_ms > 0
           AND state.last_played_at IS NOT NULL
           AND item.missing_since IS NULL
           AND item.kind IN ('movie', 'episode', 'book')
           -- Ignore a position in the first moments or the trailing credits:
           -- neither is something the user wants offered as "continue".
           AND (
             item.runtime_ms IS NULL
             OR (state.position_ms > 30000 AND state.position_ms < item.runtime_ms * 0.95)
           )
         ORDER BY state.last_played_at DESC
         LIMIT $2`,
        [userId, limit],
      );
      return result.rows.map((row) => ({
        itemId: row.item_id,
        lastPlayedAt: row.last_played_at,
      }));
    },

    listFavourites: async (userId, limit) => {
      const result = await pool.query<{ item_id: string }>(
        `SELECT state.item_id
         FROM user_item_state state
         JOIN items item ON item.id = state.item_id
         WHERE state.user_id = $1 AND state.is_favourite = true AND item.missing_since IS NULL
         ORDER BY state.updated_at DESC
         LIMIT $2`,
        [userId, limit],
      );
      return result.rows.map((row) => row.item_id);
    },
  };
}
