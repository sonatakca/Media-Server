import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import type { SyncplayGroupState, SyncplayMemberState } from "./syncplayState";

export interface SyncplayGroup {
  id: string;
  name: string;
  ownerUserId: string;
  itemId: string | null;
  state: SyncplayGroupState;
  createdAt: Date;
}

export interface SyncplayRepository {
  create(input: {
    name: string;
    ownerUserId: string;
    itemId: string | null;
    displayName: string;
  }): Promise<SyncplayGroup>;
  findById(groupId: string): Promise<SyncplayGroup | null>;
  listOpen(): Promise<Array<SyncplayGroup & { memberCount: number }>>;
  listMembers(groupId: string): Promise<SyncplayMemberState[]>;
  join(groupId: string, userId: string, displayName: string): Promise<void>;
  leave(groupId: string, userId: string): Promise<void>;
  isMember(groupId: string, userId: string): Promise<boolean>;
  /**
   * Applies a state transition only when the sequence still advances, in one
   * statement, so two simultaneous commands cannot both win.
   */
  applyState(
    groupId: string,
    state: SyncplayGroupState,
  ): Promise<SyncplayGroup | null>;
  updateMember(
    groupId: string,
    userId: string,
    update: { isReady?: boolean; isBuffering?: boolean; positionMs?: number },
  ): Promise<void>;
  close(groupId: string): Promise<void>;
  setItem(groupId: string, itemId: string): Promise<void>;
  /** Removes groups whose members have all gone. */
  closeEmptyGroups(): Promise<string[]>;
}

interface RawGroupRow {
  id: string;
  name: string;
  owner_user_id: string;
  item_id: string | null;
  sequence: string;
  is_playing: boolean;
  position_ms: string;
  position_updated_at: Date;
  created_at: Date;
}

const GROUP_COLUMNS = `
  id, name, owner_user_id, item_id, sequence, is_playing,
  position_ms, position_updated_at, created_at
`;

function toGroup(row: RawGroupRow): SyncplayGroup {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    itemId: row.item_id,
    state: {
      sequence: Number(row.sequence),
      isPlaying: row.is_playing,
      positionMs: Number(row.position_ms),
      positionUpdatedAt: row.position_updated_at.getTime(),
    },
    createdAt: row.created_at,
  };
}

export function createSyncplayRepository(
  pool: DatabasePool,
): SyncplayRepository {
  return {
    create: async ({ name, ownerUserId, itemId, displayName }) => {
      const groupId = randomUUID();
      const result = await pool.query<RawGroupRow>(
        `INSERT INTO syncplay_groups (id, name, owner_user_id, item_id)
         VALUES ($1, $2, $3, $4)
         RETURNING ${GROUP_COLUMNS}`,
        [groupId, name, ownerUserId, itemId],
      );

      await pool.query(
        `INSERT INTO syncplay_members (group_id, user_id, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, ownerUserId, displayName],
      );

      const row = result.rows[0];
      if (!row) throw new Error("Group creation returned no row.");
      return toGroup(row);
    },

    findById: async (groupId) => {
      const result = await pool.query<RawGroupRow>(
        `SELECT ${GROUP_COLUMNS} FROM syncplay_groups
         WHERE id = $1 AND closed_at IS NULL`,
        [groupId],
      );
      const row = result.rows[0];
      return row ? toGroup(row) : null;
    },

    listOpen: async () => {
      const result = await pool.query<RawGroupRow & { member_count: string }>(
        `SELECT ${GROUP_COLUMNS},
                (SELECT count(*) FROM syncplay_members m WHERE m.group_id = syncplay_groups.id) AS member_count
         FROM syncplay_groups
         WHERE closed_at IS NULL
         ORDER BY created_at DESC`,
      );
      return result.rows.map((row) => ({
        ...toGroup(row),
        memberCount: Number(row.member_count),
      }));
    },

    listMembers: async (groupId) => {
      const result = await pool.query<{
        user_id: string;
        display_name: string;
        is_ready: boolean;
        is_buffering: boolean;
        last_position_ms: string;
        last_seen_at: Date;
      }>(
        `SELECT user_id, display_name, is_ready, is_buffering, last_position_ms, last_seen_at
         FROM syncplay_members WHERE group_id = $1 ORDER BY joined_at`,
        [groupId],
      );

      return result.rows.map<SyncplayMemberState>((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        isReady: row.is_ready,
        isBuffering: row.is_buffering,
        lastPositionMs: Number(row.last_position_ms),
        lastSeenAt: row.last_seen_at.getTime(),
      }));
    },

    join: async (groupId, userId, displayName) => {
      await pool.query(
        `INSERT INTO syncplay_members (group_id, user_id, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_id, user_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           last_seen_at = now(),
           -- Rejoining always starts unready: the client must confirm it has
           -- the media buffered before the group waits on it.
           is_ready = false,
           is_buffering = false`,
        [groupId, userId, displayName],
      );
    },

    leave: async (groupId, userId) => {
      await pool.query(
        `DELETE FROM syncplay_members WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId],
      );
    },

    isMember: async (groupId, userId) => {
      const result = await pool.query(
        `SELECT 1 FROM syncplay_members WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    applyState: async (groupId, state) => {
      const result = await pool.query<RawGroupRow>(
        `UPDATE syncplay_groups SET
           sequence = $2,
           is_playing = $3,
           position_ms = $4,
           position_updated_at = to_timestamp($5::double precision / 1000)
         WHERE id = $1
           AND closed_at IS NULL
           -- The guard is what makes two simultaneous commands safe: the loser
           -- updates nothing and is told its command was stale.
           AND sequence < $2
         RETURNING ${GROUP_COLUMNS}`,
        [
          groupId,
          state.sequence,
          state.isPlaying,
          Math.max(0, Math.round(state.positionMs)),
          state.positionUpdatedAt,
        ],
      );
      const row = result.rows[0];
      return row ? toGroup(row) : null;
    },

    updateMember: async (groupId, userId, update) => {
      await pool.query(
        `UPDATE syncplay_members SET
           is_ready = COALESCE($3, is_ready),
           is_buffering = COALESCE($4, is_buffering),
           last_position_ms = COALESCE($5, last_position_ms),
           last_seen_at = now()
         WHERE group_id = $1 AND user_id = $2`,
        [
          groupId,
          userId,
          update.isReady ?? null,
          update.isBuffering ?? null,
          update.positionMs === undefined
            ? null
            : Math.max(0, Math.round(update.positionMs)),
        ],
      );
    },

    close: async (groupId) => {
      await pool.query(
        `UPDATE syncplay_groups SET closed_at = now()
         WHERE id = $1 AND closed_at IS NULL`,
        [groupId],
      );
    },

    setItem: async (groupId, itemId) => {
      await pool.query(
        `UPDATE syncplay_groups SET item_id = $2 WHERE id = $1`,
        [groupId, itemId],
      );
    },

    closeEmptyGroups: async () => {
      const result = await pool.query<{ id: string }>(
        `UPDATE syncplay_groups SET closed_at = now()
         WHERE closed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM syncplay_members m WHERE m.group_id = syncplay_groups.id
           )
         RETURNING id`,
      );
      return result.rows.map((row) => row.id);
    },
  };
}
