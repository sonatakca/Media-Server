-- User media state, settings, durable jobs, activity, playback sessions and
-- SyncPlay groups.

CREATE TABLE user_item_state (
  user_id uuid NOT NULL REFERENCES native_users(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position_ms bigint NOT NULL DEFAULT 0,
  played boolean NOT NULL DEFAULT false,
  play_count integer NOT NULL DEFAULT 0,
  is_favourite boolean NOT NULL DEFAULT false,
  last_played_at timestamptz,
  -- Monotonic per (user, item). A progress write carrying a sequence at or
  -- below the stored one is rejected, so a delayed retry from a paused tab can
  -- never rewind a position the user has since moved forward.
  progress_sequence bigint NOT NULL DEFAULT 0,
  audio_stream_index integer,
  subtitle_stream_index integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id),
  CONSTRAINT user_item_state_position_nonnegative CHECK (position_ms >= 0),
  CONSTRAINT user_item_state_play_count_nonnegative CHECK (play_count >= 0)
);

CREATE INDEX user_item_state_resume_idx
  ON user_item_state (user_id, last_played_at DESC)
  WHERE position_ms > 0 AND played = false;
CREATE INDEX user_item_state_favourite_idx
  ON user_item_state (user_id, is_favourite)
  WHERE is_favourite = true;
CREATE INDEX user_item_state_item_idx ON user_item_state (item_id);

CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY REFERENCES native_users(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE server_settings (
  key varchar(120) PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES native_users(id) ON DELETE SET NULL
);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES native_users(id) ON DELETE CASCADE,
  device_key varchar(128) NOT NULL,
  description varchar(200),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_key)
);

CREATE INDEX devices_user_idx ON devices (user_id, revoked_at);

-- Durable job queue. PostgreSQL is the only correctness-bearing store: a lease
-- with an expiry lets a crashed worker's job be retried without a broker.
CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  job_type varchar(64) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  priority integer NOT NULL DEFAULT 100,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(128),
  lease_expires_at timestamptz,
  progress real NOT NULL DEFAULT 0,
  progress_message varchar(300),
  -- Two jobs that would do the same work collapse onto one row while queued or
  -- running, so a user hammering "scan library" cannot flood the worker.
  dedupe_key varchar(200),
  cancellation_requested boolean NOT NULL DEFAULT false,
  safe_error varchar(500),
  result jsonb,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT jobs_status_known
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT jobs_progress_range CHECK (progress >= 0 AND progress <= 1),
  CONSTRAINT jobs_attempts_nonnegative CHECK (attempts >= 0 AND max_attempts > 0)
);

CREATE UNIQUE INDEX jobs_dedupe_active_idx
  ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
CREATE INDEX jobs_claim_idx
  ON jobs (status, priority, run_after)
  WHERE status = 'queued';
CREATE INDEX jobs_lease_idx
  ON jobs (lease_expires_at)
  WHERE status = 'running';
CREATE INDEX jobs_history_idx ON jobs (job_type, queued_at DESC);

CREATE TABLE job_schedules (
  id uuid PRIMARY KEY,
  job_type varchar(64) NOT NULL UNIQUE,
  interval_seconds integer NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled boolean NOT NULL DEFAULT true,
  last_queued_at timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_schedules_interval_range
    CHECK (interval_seconds >= 60 AND interval_seconds <= 2592000)
);

CREATE TABLE activity_events (
  id bigserial PRIMARY KEY,
  event_type varchar(64) NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  user_id uuid REFERENCES native_users(id) ON DELETE SET NULL,
  item_id uuid REFERENCES items(id) ON DELETE SET NULL,
  -- Sanitized at write time: never contains paths, tokens, or FFmpeg arguments.
  summary varchar(300) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_events_severity_known
    CHECK (severity IN ('info', 'warning', 'error'))
);

CREATE INDEX activity_events_recent_idx ON activity_events (created_at DESC);
CREATE INDEX activity_events_type_idx ON activity_events (event_type, created_at DESC);

-- Playback sessions are durable so that an admin dashboard and a restarted
-- process both see the same truth, and so a session-bound delivery URL can be
-- authorized without trusting the client.
CREATE TABLE playback_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES native_users(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  media_file_id uuid NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  audio_stream_index integer,
  subtitle_stream_index integer,
  max_height integer,
  max_bitrate_bps bigint,
  runtime_key varchar(200),
  position_ms bigint NOT NULL DEFAULT 0,
  is_paused boolean NOT NULL DEFAULT false,
  reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT playback_sessions_mode_known
    CHECK (mode IN ('DIRECT_PLAY', 'REMUX', 'DIRECT_STREAM', 'TRANSCODE')),
  CONSTRAINT playback_sessions_status_known
    CHECK (status IN ('active', 'ended', 'failed'))
);

CREATE INDEX playback_sessions_active_idx
  ON playback_sessions (status, last_activity_at)
  WHERE status = 'active';
CREATE INDEX playback_sessions_user_idx ON playback_sessions (user_id, created_at DESC);

CREATE TABLE syncplay_groups (
  id uuid PRIMARY KEY,
  name varchar(120) NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES native_users(id) ON DELETE CASCADE,
  item_id uuid REFERENCES items(id) ON DELETE SET NULL,
  -- Authoritative playback state. `sequence` orders commands so a late frame
  -- from a slow client can be discarded rather than rewinding everyone.
  sequence bigint NOT NULL DEFAULT 0,
  is_playing boolean NOT NULL DEFAULT false,
  position_ms bigint NOT NULL DEFAULT 0,
  -- Server clock at which `position_ms` was true; clients extrapolate from here.
  position_updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT syncplay_groups_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT syncplay_groups_position_nonnegative CHECK (position_ms >= 0)
);

CREATE INDEX syncplay_groups_open_idx ON syncplay_groups (closed_at) WHERE closed_at IS NULL;

CREATE TABLE syncplay_members (
  group_id uuid NOT NULL REFERENCES syncplay_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES native_users(id) ON DELETE CASCADE,
  display_name varchar(100) NOT NULL,
  is_ready boolean NOT NULL DEFAULT false,
  is_buffering boolean NOT NULL DEFAULT false,
  last_position_ms bigint NOT NULL DEFAULT 0,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX syncplay_members_user_idx ON syncplay_members (user_id);
