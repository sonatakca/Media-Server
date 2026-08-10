import type { DatabasePool } from "../database/databasePool";

/**
 * Home-screen queries. These are the ones where doing the work in SQL matters:
 * "next up" over a whole library is a per-series ranking, and computing it by
 * loading every episode into the process would not survive a real library.
 */
export interface HomeRepository {
  listNextUpEpisodeIds(userId: string, limit: number): Promise<string[]>;
  listLatestItemIds(
    userId: string,
    limit: number,
    libraryId?: string,
  ): Promise<string[]>;
  listLatestPerLibrary(
    userId: string,
    perLibraryLimit: number,
  ): Promise<Map<string, string[]>>;
  /** First unwatched episode of a series, for "play from the start". */
  findFirstUnwatchedEpisodeId(
    userId: string,
    seriesId: string,
  ): Promise<string | null>;
  findNextEpisodeId(userId: string, episodeId: string): Promise<string | null>;
}

/** Shared visibility guard, expressed against an alias named `item`. */
const VISIBLE_TO_VIEWER = `
  EXISTS (
    SELECT 1 FROM native_users viewer
    WHERE viewer.id = $1
      AND viewer.is_disabled = false
      AND (
        viewer.allow_all_libraries
        OR EXISTS (
          SELECT 1 FROM user_library_permissions grant_row
          WHERE grant_row.user_id = viewer.id AND grant_row.library_id = item.library_id
        )
      )
  )
`;

export function createHomeRepository(pool: DatabasePool): HomeRepository {
  return {
    listNextUpEpisodeIds: async (userId, limit) => {
      const result = await pool.query<{ id: string }>(
        `WITH last_watched AS (
           -- Highest-numbered played episode per series: the point the viewer
           -- has reached, regardless of the order they watched in.
           SELECT DISTINCT ON (item.series_id)
             item.series_id,
             COALESCE(item.parent_index_number, 0) AS season_number,
             COALESCE(item.index_number, 0) AS episode_number,
             state.last_played_at
           FROM user_item_state state
           JOIN items item ON item.id = state.item_id AND item.kind = 'episode'
           WHERE state.user_id = $1
             AND state.played = true
             AND item.series_id IS NOT NULL
             AND ${VISIBLE_TO_VIEWER}
           ORDER BY
             item.series_id,
             COALESCE(item.parent_index_number, 0) DESC,
             COALESCE(item.index_number, 0) DESC
         ),
         next_up AS (
           SELECT DISTINCT ON (item.series_id)
             item.id,
             item.series_id,
             last_watched.last_played_at
           FROM last_watched
           JOIN items item
             ON item.series_id = last_watched.series_id
            AND item.kind = 'episode'
            AND item.missing_since IS NULL
            -- Specials are never offered as the next episode.
            AND COALESCE(item.parent_index_number, 0) > 0
            AND (COALESCE(item.parent_index_number, 0), COALESCE(item.index_number, 0))
                > (last_watched.season_number, last_watched.episode_number)
           LEFT JOIN user_item_state candidate_state
             ON candidate_state.user_id = $1 AND candidate_state.item_id = item.id
           WHERE COALESCE(candidate_state.played, false) = false
             AND ${VISIBLE_TO_VIEWER}
           ORDER BY
             item.series_id,
             COALESCE(item.parent_index_number, 0),
             COALESCE(item.index_number, 0)
         )
         SELECT id FROM next_up
         ORDER BY last_played_at DESC
         LIMIT $2`,
        [userId, limit],
      );
      return result.rows.map((row) => row.id);
    },

    listLatestItemIds: async (userId, limit, libraryId) => {
      const values: unknown[] = [userId, limit];
      let libraryFilter = "";
      if (libraryId) {
        values.push(libraryId);
        libraryFilter = `AND item.library_id = $${values.length}`;
      }

      const result = await pool.query<{ id: string }>(
        `SELECT item.id
         FROM items item
         WHERE item.kind IN ('movie', 'series', 'book')
           AND item.missing_since IS NULL
           ${libraryFilter}
           AND ${VISIBLE_TO_VIEWER}
         ORDER BY item.date_created DESC, item.id DESC
         LIMIT $2`,
        values,
      );
      return result.rows.map((row) => row.id);
    },

    listLatestPerLibrary: async (userId, perLibraryLimit) => {
      const result = await pool.query<{ library_id: string; id: string }>(
        `SELECT library_id, id FROM (
           SELECT
             item.library_id,
             item.id,
             row_number() OVER (
               PARTITION BY item.library_id
               ORDER BY item.date_created DESC, item.id DESC
             ) AS position
           FROM items item
           WHERE item.kind IN ('movie', 'series', 'book')
             AND item.missing_since IS NULL
             AND ${VISIBLE_TO_VIEWER}
         ) ranked
         WHERE position <= $2
         ORDER BY library_id, position`,
        [userId, perLibraryLimit],
      );

      const byLibrary = new Map<string, string[]>();
      for (const row of result.rows) {
        const existing = byLibrary.get(row.library_id);
        if (existing) existing.push(row.id);
        else byLibrary.set(row.library_id, [row.id]);
      }
      return byLibrary;
    },

    findFirstUnwatchedEpisodeId: async (userId, seriesId) => {
      const result = await pool.query<{ id: string }>(
        `SELECT item.id
         FROM items item
         LEFT JOIN user_item_state state
           ON state.user_id = $1 AND state.item_id = item.id
         WHERE item.series_id = $2
           AND item.kind = 'episode'
           AND item.missing_since IS NULL
           AND COALESCE(item.parent_index_number, 0) > 0
           AND COALESCE(state.played, false) = false
           AND ${VISIBLE_TO_VIEWER}
         ORDER BY
           COALESCE(item.parent_index_number, 0),
           COALESCE(item.index_number, 0)
         LIMIT 1`,
        [userId, seriesId],
      );
      return result.rows[0]?.id ?? null;
    },

    findNextEpisodeId: async (userId, episodeId) => {
      const result = await pool.query<{ id: string }>(
        `WITH current AS (
           SELECT series_id,
                  COALESCE(parent_index_number, 0) AS season_number,
                  COALESCE(index_number, 0) AS episode_number
           FROM items WHERE id = $2 AND kind = 'episode'
         )
         SELECT item.id
         FROM items item
         JOIN current ON current.series_id = item.series_id
         WHERE item.kind = 'episode'
           AND item.missing_since IS NULL
           AND COALESCE(item.parent_index_number, 0) > 0
           AND (COALESCE(item.parent_index_number, 0), COALESCE(item.index_number, 0))
               > (current.season_number, current.episode_number)
           AND ${VISIBLE_TO_VIEWER}
         ORDER BY
           COALESCE(item.parent_index_number, 0),
           COALESCE(item.index_number, 0)
         LIMIT 1`,
        [userId, episodeId],
      );
      return result.rows[0]?.id ?? null;
    },
  };
}
