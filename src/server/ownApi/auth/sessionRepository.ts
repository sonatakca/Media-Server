import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../database/transaction";

interface SessionUserRow {
  id: string;
  user_id: string;
  family_id: string;
  absolute_expires_at: Date;
  idle_expires_at: Date;
  revoked_at: Date | null;
  rotated_to_session_id: string | null;
  normalized_username: string;
  display_name: string;
  is_administrator: boolean;
  is_disabled: boolean;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  isAdministrator: boolean;
  isDisabled: boolean;
}

export interface ActiveNativeSession {
  sessionId: string;
  familyId: string;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
  user: SessionUser;
}

export interface CreateSessionInput {
  id: string;
  userId: string;
  tokenHash: Buffer;
  familyId: string;
  createdAt: Date;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
  deviceDescription?: string;
}

export interface RotateSessionInput {
  previousTokenHash: Buffer;
  newSessionId: string;
  newTokenHash: Buffer;
  now: Date;
  idleExpiresAt: Date;
}

export type RotateSessionResult =
  | { status: "rotated"; session: ActiveNativeSession }
  | { status: "invalid" }
  | { status: "reused" };

function mapSession(row: SessionUserRow): ActiveNativeSession {
  return {
    sessionId: row.id,
    familyId: row.family_id,
    absoluteExpiresAt: row.absolute_expires_at,
    idleExpiresAt: row.idle_expires_at,
    user: {
      id: row.user_id,
      username: row.normalized_username,
      displayName: row.display_name,
      isAdministrator: row.is_administrator,
      isDisabled: row.is_disabled,
    },
  };
}

const SESSION_USER_COLUMNS = `
  s.id,
  s.user_id,
  s.family_id,
  s.absolute_expires_at,
  s.idle_expires_at,
  s.revoked_at,
  s.rotated_to_session_id,
  u.normalized_username,
  u.display_name,
  u.is_administrator,
  u.is_disabled
`;

export interface SessionRepository {
  create(input: CreateSessionInput): Promise<ActiveNativeSession>;
  findAndTouchActive(
    tokenHash: Buffer,
    now: Date,
    idleExpiresAt: Date,
  ): Promise<ActiveNativeSession | null>;
  rotate(input: RotateSessionInput): Promise<RotateSessionResult>;
  revokeFamilyByTokenHash(tokenHash: Buffer, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<void>;
  cleanupExpired(at: Date): Promise<number>;
}

async function selectSessionForUpdate(
  client: PoolClient,
  tokenHash: Buffer,
): Promise<SessionUserRow | undefined> {
  const result = await client.query<SessionUserRow>(
    `SELECT ${SESSION_USER_COLUMNS}
     FROM native_sessions s
     JOIN native_users u ON u.id = s.user_id
     WHERE s.token_hash = $1
     FOR UPDATE OF s`,
    [tokenHash],
  );
  return result.rows[0];
}

export function createSessionRepository(
  pool: Pick<Pool, "connect" | "query">,
): SessionRepository {
  return {
    async create(input) {
      await pool.query(
        `INSERT INTO native_sessions (
          id, user_id, token_hash, family_id, created_at, last_used_at,
          absolute_expires_at, idle_expires_at, device_description
        ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8)`,
        [
          input.id,
          input.userId,
          input.tokenHash,
          input.familyId,
          input.createdAt,
          input.absoluteExpiresAt,
          input.idleExpiresAt,
          input.deviceDescription ?? null,
        ],
      );
      const result = await pool.query<SessionUserRow>(
        `SELECT ${SESSION_USER_COLUMNS}
         FROM native_sessions s
         JOIN native_users u ON u.id = s.user_id
         WHERE s.id = $1`,
        [input.id],
      );
      return mapSession(result.rows[0] as SessionUserRow);
    },

    async findAndTouchActive(tokenHash, now, idleExpiresAt) {
      const result = await pool.query<SessionUserRow>(
        `UPDATE native_sessions s
         SET last_used_at = $2,
             idle_expires_at = LEAST(s.absolute_expires_at, $3)
         FROM native_users u
         WHERE s.token_hash = $1
           AND u.id = s.user_id
           AND s.revoked_at IS NULL
           AND s.rotated_to_session_id IS NULL
           AND s.absolute_expires_at > $2
           AND s.idle_expires_at > $2
           AND u.is_disabled = false
         RETURNING ${SESSION_USER_COLUMNS}`,
        [tokenHash, now, idleExpiresAt],
      );
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    },

    async rotate(input) {
      return withTransaction(pool, async (client) => {
        const previous = await selectSessionForUpdate(
          client,
          input.previousTokenHash,
        );

        if (!previous) {
          return { status: "invalid" };
        }

        if (previous.rotated_to_session_id) {
          await client.query(
            `UPDATE native_sessions
             SET revoked_at = COALESCE(revoked_at, $2)
             WHERE family_id = $1`,
            [previous.family_id, input.now],
          );
          return { status: "reused" };
        }

        if (
          previous.revoked_at ||
          previous.absolute_expires_at <= input.now ||
          previous.idle_expires_at <= input.now ||
          previous.is_disabled
        ) {
          if (previous.is_disabled) {
            await client.query(
              `UPDATE native_sessions
               SET revoked_at = COALESCE(revoked_at, $2)
               WHERE family_id = $1`,
              [previous.family_id, input.now],
            );
          }
          return { status: "invalid" };
        }

        const idleExpiresAt =
          input.idleExpiresAt < previous.absolute_expires_at
            ? input.idleExpiresAt
            : previous.absolute_expires_at;
        await client.query(
          `INSERT INTO native_sessions (
            id, user_id, token_hash, family_id, created_at, last_used_at,
            absolute_expires_at, idle_expires_at, device_description
          )
          SELECT $1, user_id, $2, family_id, $3, $3,
                 absolute_expires_at, $4, device_description
          FROM native_sessions
          WHERE id = $5`,
          [
            input.newSessionId,
            input.newTokenHash,
            input.now,
            idleExpiresAt,
            previous.id,
          ],
        );
        await client.query(
          `UPDATE native_sessions
           SET revoked_at = $2, rotated_to_session_id = $3
           WHERE id = $1`,
          [previous.id, input.now, input.newSessionId],
        );
        const rotated = await client.query<SessionUserRow>(
          `SELECT ${SESSION_USER_COLUMNS}
           FROM native_sessions s
           JOIN native_users u ON u.id = s.user_id
           WHERE s.id = $1`,
          [input.newSessionId],
        );
        return {
          status: "rotated",
          session: mapSession(rotated.rows[0] as SessionUserRow),
        };
      });
    },

    async revokeFamilyByTokenHash(tokenHash, at) {
      await withTransaction(pool, async (client) => {
        const session = await selectSessionForUpdate(client, tokenHash);
        if (!session) {
          return;
        }
        await client.query(
          `UPDATE native_sessions
           SET revoked_at = COALESCE(revoked_at, $2)
           WHERE family_id = $1`,
          [session.family_id, at],
        );
      });
    },

    async revokeAllForUser(userId, at) {
      await pool.query(
        `UPDATE native_sessions
         SET revoked_at = COALESCE(revoked_at, $2)
         WHERE user_id = $1`,
        [userId, at],
      );
    },

    async cleanupExpired(at) {
      const result = await pool.query(
        `DELETE FROM native_sessions
         WHERE absolute_expires_at <= $1 OR idle_expires_at <= $1`,
        [at],
      );
      return result.rowCount ?? 0;
    },
  };
}
