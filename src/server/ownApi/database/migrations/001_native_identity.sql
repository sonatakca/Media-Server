CREATE TABLE native_users (
  id uuid PRIMARY KEY,
  normalized_username varchar(64) NOT NULL UNIQUE,
  display_name varchar(100) NOT NULL,
  password_hash text NOT NULL,
  is_administrator boolean NOT NULL DEFAULT false,
  is_disabled boolean NOT NULL DEFAULT false,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_successful_login_at timestamptz,
  CONSTRAINT native_users_normalized_username_nonempty
    CHECK (length(normalized_username) > 0),
  CONSTRAINT native_users_display_name_nonempty
    CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT native_users_password_hash_argon2id
    CHECK (password_hash LIKE '$argon2id$%')
);

CREATE TABLE native_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES native_users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  family_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_to_session_id uuid REFERENCES native_sessions(id) ON DELETE SET NULL,
  device_description varchar(200),
  CONSTRAINT native_sessions_expiration_order
    CHECK (idle_expires_at <= absolute_expires_at)
);

CREATE INDEX native_sessions_user_active_idx
  ON native_sessions (user_id, revoked_at, absolute_expires_at);
CREATE INDEX native_sessions_family_idx
  ON native_sessions (family_id);
CREATE INDEX native_sessions_expiry_idx
  ON native_sessions (absolute_expires_at, idle_expires_at)
  WHERE revoked_at IS NULL;
