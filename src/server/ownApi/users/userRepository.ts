import type { DatabaseExecutor } from "../database/databaseTypes";

interface UserRow {
  id: string;
  normalized_username: string;
  display_name: string;
  password_hash: string;
  is_administrator: boolean;
  is_disabled: boolean;
  password_changed_at: Date;
  created_at: Date;
  updated_at: Date;
  last_successful_login_at: Date | null;
}

export interface NativeUserRecord {
  id: string;
  normalizedUsername: string;
  displayName: string;
  passwordHash: string;
  isAdministrator: boolean;
  isDisabled: boolean;
  passwordChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastSuccessfulLoginAt: Date | null;
}

export interface CreateNativeUserInput {
  id: string;
  normalizedUsername: string;
  displayName: string;
  passwordHash: string;
  isAdministrator: boolean;
}

function mapUser(row: UserRow): NativeUserRecord {
  return {
    id: row.id,
    normalizedUsername: row.normalized_username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    isAdministrator: row.is_administrator,
    isDisabled: row.is_disabled,
    passwordChangedAt: row.password_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSuccessfulLoginAt: row.last_successful_login_at,
  };
}

export interface UserRepository {
  create(input: CreateNativeUserInput): Promise<NativeUserRecord>;
  findById(id: string): Promise<NativeUserRecord | null>;
  findByNormalizedUsername(username: string): Promise<NativeUserRecord | null>;
  countEligibleAdministrators(): Promise<number>;
  recordSuccessfulLogin(id: string, at: Date): Promise<void>;
}

export function createUserRepository(
  database: DatabaseExecutor,
): UserRepository {
  return {
    async create(input) {
      const result = await database.query<UserRow>(
        `INSERT INTO native_users (
          id, normalized_username, display_name, password_hash, is_administrator
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [
          input.id,
          input.normalizedUsername,
          input.displayName,
          input.passwordHash,
          input.isAdministrator,
        ],
      );
      return mapUser(result.rows[0] as UserRow);
    },

    async findById(id) {
      const result = await database.query<UserRow>(
        "SELECT * FROM native_users WHERE id = $1",
        [id],
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async findByNormalizedUsername(username) {
      const result = await database.query<UserRow>(
        "SELECT * FROM native_users WHERE normalized_username = $1",
        [username],
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async countEligibleAdministrators() {
      const result = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM native_users
         WHERE is_administrator = true AND is_disabled = false`,
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async recordSuccessfulLogin(id, at) {
      await database.query(
        `UPDATE native_users
         SET last_successful_login_at = $2, updated_at = $2
         WHERE id = $1`,
        [id, at],
      );
    },
  };
}
