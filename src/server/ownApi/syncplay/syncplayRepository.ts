import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";

/**
 * Durable half of Party Watch: a group's identity and its timeline.
 *
 * Only what must survive a server restart is stored. Participants, their
 * readiness and their connections are properties of live connections and live
 * in the runtime's memory; after a restart every client re-joins on its own,
 * and the group resumes from the timeline stored here.
 *
 * `syncplay_members` (migration 003) is no longer read or written: membership
 * is a live connection, not a row.
 */

export interface SyncplayGroupRecord {
  id: string;
  name: string;
  ownerUserId: string;
  itemId: string | null;
  revision: number;
  isPlaying: boolean;
  positionMs: number;
  /** Server clock at which `positionMs` was true. */
  positionUpdatedAt: number;
}

export interface SyncplayTimelineWrite {
  revision: number;
  itemId: string | null;
  isPlaying: boolean;
  positionMs: number;
  anchorMs: number;
}

export interface SyncplayRepository {
  create(input: {
    name: string;
    ownerUserId: string;
    itemId: string | null;
  }): Promise<SyncplayGroupRecord>;
  findOpen(groupId: string): Promise<SyncplayGroupRecord | null>;
  /**
   * Stores a timeline only if it is newer than the stored one, so writes that
   * complete out of order can never put an older state back.
   */
  saveTimeline(groupId: string, timeline: SyncplayTimelineWrite): Promise<void>;
  close(groupId: string): Promise<void>;
  /** Closes every open group not in `keepIds`; returns the ids it closed. */
  closeOpenExcept(keepIds: readonly string[]): Promise<string[]>;
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
}

const GROUP_COLUMNS = `
  id, name, owner_user_id, item_id, sequence, is_playing,
  position_ms, position_updated_at
`;

function toRecord(row: RawGroupRow): SyncplayGroupRecord {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    itemId: row.item_id,
    revision: Number(row.sequence),
    isPlaying: row.is_playing,
    positionMs: Number(row.position_ms),
    positionUpdatedAt: row.position_updated_at.getTime(),
  };
}

export function createSyncplayRepository(
  pool: DatabasePool,
): SyncplayRepository {
  return {
    create: async ({ name, ownerUserId, itemId }) => {
      const result = await pool.query<RawGroupRow>(
        `INSERT INTO syncplay_groups (id, name, owner_user_id, item_id)
         VALUES ($1, $2, $3, $4)
         RETURNING ${GROUP_COLUMNS}`,
        [randomUUID(), name, ownerUserId, itemId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Group creation returned no row.");
      return toRecord(row);
    },

    findOpen: async (groupId) => {
      const result = await pool.query<RawGroupRow>(
        `SELECT ${GROUP_COLUMNS} FROM syncplay_groups
         WHERE id = $1 AND closed_at IS NULL`,
        [groupId],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    saveTimeline: async (groupId, timeline) => {
      await pool.query(
        `UPDATE syncplay_groups SET
           sequence = $2,
           item_id = $3,
           is_playing = $4,
           position_ms = $5,
           position_updated_at = to_timestamp($6::double precision / 1000)
         WHERE id = $1
           AND closed_at IS NULL
           AND sequence < $2`,
        [
          groupId,
          timeline.revision,
          timeline.itemId,
          timeline.isPlaying,
          Math.max(0, Math.round(timeline.positionMs)),
          timeline.anchorMs,
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

    closeOpenExcept: async (keepIds) => {
      const result = await pool.query<{ id: string }>(
        `UPDATE syncplay_groups SET closed_at = now()
         WHERE closed_at IS NULL AND NOT (id = ANY($1::uuid[]))
         RETURNING id`,
        [keepIds],
      );
      return result.rows.map((row) => row.id);
    },
  };
}
