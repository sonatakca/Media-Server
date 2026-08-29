-- Media processing jobs.
--
-- The generic `jobs` table already provides durable scheduling: leases, retry,
-- dedupe and cancellation. It deliberately knows nothing about media, so the
-- processing-specific record lives beside it and references it. A processing
-- job therefore has one scheduling row and one domain row, and the worker that
-- claims the first updates the second.

CREATE TABLE processing_jobs (
  id uuid PRIMARY KEY,
  -- The scheduling row this job runs on. Null until it has been enqueued,
  -- which lets a decision be previewed and stored before anything is queued.
  job_id uuid REFERENCES jobs (id) ON DELETE SET NULL,
  item_id uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  media_file_id uuid NOT NULL REFERENCES media_files (id) ON DELETE CASCADE,
  -- Identifies the exact bytes this job was planned against. A source that is
  -- replaced under a queued job no longer matches, and the job is rejected
  -- rather than packaging one file's plan onto another file's content.
  source_fingerprint varchar(128) NOT NULL,
  profile varchar(64) NOT NULL,

  state text NOT NULL DEFAULT 'pending',
  stage text NOT NULL DEFAULT 'waiting',
  stage_progress real NOT NULL DEFAULT 0,
  overall_progress real NOT NULL DEFAULT 0,

  bytes_processed bigint NOT NULL DEFAULT 0,
  output_bytes bigint,
  estimated_output_bytes bigint,
  estimated_staging_bytes bigint,
  speed real,
  fps real,
  eta_seconds integer,

  hardware_adapter varchar(32),
  video_encoder varchar(32),

  -- The decision the operator saw, the stream keep/drop reasons, the validation
  -- findings and the warnings. Stored rather than recomputed so the record of
  -- what a job did cannot drift from what it actually did.
  decision jsonb,
  stream_decisions jsonb,
  validation jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,

  error_code varchar(64),
  error_message varchar(500),

  staging_directory varchar(512),
  published_version varchar(128),

  attempts integer NOT NULL DEFAULT 0,
  cancellation_requested boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT processing_jobs_state_known CHECK (
    state IN ('pending', 'queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT processing_jobs_stage_known CHECK (
    stage IN ('waiting', 'analysing', 'planning', 'video', 'audio', 'subtitles',
              'packaging', 'validating', 'publishing', 'complete')
  ),
  CONSTRAINT processing_jobs_progress_range CHECK (
    stage_progress >= 0 AND stage_progress <= 1
    AND overall_progress >= 0 AND overall_progress <= 1
  ),
  CONSTRAINT processing_jobs_attempts_nonnegative CHECK (attempts >= 0)
);

-- One active job per media file. Two workers cannot process the same source,
-- and an operator cannot queue the same title twice by pressing the button
-- again. Finished jobs are left alone so the history stays complete.
CREATE UNIQUE INDEX processing_jobs_active_file_idx
  ON processing_jobs (media_file_id)
  WHERE state IN ('pending', 'queued', 'running', 'paused');

CREATE INDEX processing_jobs_state_idx ON processing_jobs (state, created_at DESC);
CREATE INDEX processing_jobs_item_idx ON processing_jobs (item_id, created_at DESC);
CREATE INDEX processing_jobs_recent_idx ON processing_jobs (created_at DESC);

-- Append-only stage history, which is what the timeline in the UI is drawn
-- from and what a restarted worker reads to know where it got to.
CREATE TABLE processing_job_events (
  id bigserial PRIMARY KEY,
  processing_job_id uuid NOT NULL REFERENCES processing_jobs (id) ON DELETE CASCADE,
  -- Monotonic per job. The live stream replays from a client's last sequence
  -- after a reconnect, so an event is delivered once and never twice.
  sequence integer NOT NULL,
  stage text NOT NULL,
  level text NOT NULL DEFAULT 'info',
  message varchar(500) NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processing_job_events_level_known CHECK (level IN ('info', 'warning', 'error'))
);

CREATE UNIQUE INDEX processing_job_events_sequence_idx
  ON processing_job_events (processing_job_id, sequence);
CREATE INDEX processing_job_events_recent_idx
  ON processing_job_events (processing_job_id, id DESC);
