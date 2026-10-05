import type { DatabasePool } from "../database/databasePool";

/** Exactly where the screen stood; see user_book_positions. */
export interface BookPlace {
  section: number;
  block: number;
  offset: number;
}

export interface BookPosition {
  cfi: string | null;
  place: BookPlace | null;
  fraction: number;
  readAt: Date;
}

export interface BookPositionRepository {
  get(userId: string, itemId: string): Promise<BookPosition | null>;
  /**
   * Stores the position unless a later one is already stored. Returns the
   * position now on record and whether this write is it.
   */
  save(
    userId: string,
    itemId: string,
    position: BookPosition,
  ): Promise<{ accepted: boolean; position: BookPosition | null }>;
}

interface RawPositionRow {
  cfi: string | null;
  section: number | null;
  block: number | null;
  block_offset: number | null;
  fraction: number;
  read_at: Date;
}

const POSITION_COLUMNS = "cfi, section, block, block_offset, fraction, read_at";

function toPosition(row: RawPositionRow): BookPosition {
  return {
    cfi: row.cfi,
    place:
      row.section === null || row.block === null || row.block_offset === null
        ? null
        : { section: row.section, block: row.block, offset: row.block_offset },
    fraction: Number(row.fraction),
    readAt: row.read_at,
  };
}

export function createBookPositionRepository(
  pool: DatabasePool,
): BookPositionRepository {
  const get = async (userId: string, itemId: string) => {
    const result = await pool.query<RawPositionRow>(
      `SELECT ${POSITION_COLUMNS} FROM user_book_positions
       WHERE user_id = $1 AND item_id = $2`,
      [userId, itemId],
    );
    const row = result.rows[0];
    return row ? toPosition(row) : null;
  };

  return {
    get,

    save: async (userId, itemId, { cfi, place, fraction, readAt }) => {
      // read_at is capped at the server's clock: a device whose clock runs
      // ahead would otherwise hold the book's place against every other
      // device until real time caught up. A tie goes to the newer write, so
      // saving the same moment twice is harmless.
      const result = await pool.query(
        `INSERT INTO user_book_positions (
           user_id, item_id, cfi, section, block, block_offset, fraction,
           read_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, LEAST($8::timestamptz, now()), now())
         ON CONFLICT (user_id, item_id) DO UPDATE SET
           cfi = EXCLUDED.cfi,
           section = EXCLUDED.section,
           block = EXCLUDED.block,
           block_offset = EXCLUDED.block_offset,
           fraction = EXCLUDED.fraction,
           read_at = EXCLUDED.read_at,
           updated_at = now()
         WHERE EXCLUDED.read_at >= user_book_positions.read_at`,
        [
          userId,
          itemId,
          cfi,
          place?.section ?? null,
          place?.block ?? null,
          place?.offset ?? null,
          fraction,
          readAt,
        ],
      );

      return {
        accepted: (result.rowCount ?? 0) > 0,
        position: await get(userId, itemId),
      };
    },
  };
}
