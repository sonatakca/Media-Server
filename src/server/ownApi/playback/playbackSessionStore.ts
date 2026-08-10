import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";

export interface PlaybackSessionRecord {
  id: string;
  userId: string;
  itemId: string;
  mediaFileId: string;
  mode: string;
  status: "active" | "ended" | "failed";
  runtimeKey: string | null;
  positionMs: number;
  isPaused: boolean;
  reasonCodes: string[];
  createdAt: Date;
}

export interface CreatePlaybackSessionInput {
  id: string;
  userId: string;
  itemId: string;
  mediaFileId: string;
  mode: string;
  runtimeKey: string | null;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number | null;
  maxHeight: number | null;
  maxBitrateBps: number | null;
  reasonCodes: string[];
}

/**
 * Playback sessions are durable rather than process-local so that an admin
 * dashboard, a second process, and a restarted server all agree on what is
 * playing, and so a session-bound delivery URL can be authorized without
 * trusting anything the client sends.
 */
export interface PlaybackSessionStore {
  nextId(): Promise<string>;
  create(input: CreatePlaybackSessionInput): Promise<void>;
  get(sessionId: string): Promise<PlaybackSessionRecord | null>;
  touch(sessionId: string): Promise<void>;
  end(sessionId: string): Promise<void>;
  listActive(): Promise<PlaybackSessionRecord[]>;
  /** Ends sessions whose client stopped talking to us. */
  expireIdle(idleMs: number): Promise<string[]>;
}

interface RawSessionRow {
  id: string;
  user_id: string;
  item_id: string;
  media_file_id: string;
  mode: string;
  status: "active" | "ended" | "failed";
  runtime_key: string | null;
  position_ms: string;
  is_paused: boolean;
  reason_codes: string[];
  created_at: Date;
}

const SESSION_COLUMNS = `
  id, user_id, item_id, media_file_id, mode, status, runtime_key,
  position_ms, is_paused, reason_codes, created_at
`;

function toRecord(row: RawSessionRow): PlaybackSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    itemId: row.item_id,
    mediaFileId: row.media_file_id,
    mode: row.mode,
    status: row.status,
    runtimeKey: row.runtime_key,
    positionMs: Number(row.position_ms),
    isPaused: row.is_paused,
    reasonCodes: row.reason_codes ?? [],
    createdAt: row.created_at,
  };
}

export function createPlaybackSessionStore(
  pool: DatabasePool,
): PlaybackSessionStore {
  return {
    nextId: async () => randomUUID(),

    create: async (input) => {
      await pool.query(
        `INSERT INTO playback_sessions (
           id, user_id, item_id, media_file_id, mode, status, runtime_key,
           audio_stream_index, subtitle_stream_index, max_height, max_bitrate_bps,
           reason_codes
         )
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11)`,
        [
          input.id,
          input.userId,
          input.itemId,
          input.mediaFileId,
          input.mode,
          input.runtimeKey,
          input.audioStreamIndex,
          input.subtitleStreamIndex,
          input.maxHeight,
          input.maxBitrateBps,
          input.reasonCodes,
        ],
      );
    },

    get: async (sessionId) => {
      const result = await pool.query<RawSessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM playback_sessions WHERE id = $1`,
        [sessionId],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    touch: async (sessionId) => {
      await pool.query(
        `UPDATE playback_sessions SET last_activity_at = now()
         WHERE id = $1 AND status = 'active'`,
        [sessionId],
      );
    },

    end: async (sessionId) => {
      await pool.query(
        `UPDATE playback_sessions SET status = 'ended', ended_at = now()
         WHERE id = $1 AND status = 'active'`,
        [sessionId],
      );
    },

    listActive: async () => {
      const result = await pool.query<RawSessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM playback_sessions
         WHERE status = 'active' ORDER BY last_activity_at DESC`,
      );
      return result.rows.map(toRecord);
    },

    expireIdle: async (idleMs) => {
      const result = await pool.query<{ id: string; runtime_key: string | null }>(
        `UPDATE playback_sessions
         SET status = 'ended', ended_at = now()
         WHERE status = 'active'
           AND last_activity_at < now() - make_interval(secs => $1)
         RETURNING id, runtime_key`,
        [Math.max(1, Math.round(idleMs / 1_000))],
      );
      return result.rows
        .map((row) => row.runtime_key)
        .filter((key): key is string => key !== null);
    },
  };
}
