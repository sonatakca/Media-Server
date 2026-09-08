-- Safe execution checkpoints contain normalized candidate facts and filesystem
-- receipt identity only. Browser/session material is never stored here.
ALTER TABLE subtitle_attempts
  ADD COLUMN selected_candidate jsonb,
  ADD COLUMN replace_existing boolean NOT NULL DEFAULT false,
  ADD COLUMN pending_installation jsonb,
  ADD COLUMN resume_stage text CHECK (resume_stage IN ('searching', 'downloading'));

-- Subsystem history follows acquisition/import history. Queue progress remains
-- in the existing leased queue, and events are committed with subtitle state.
CREATE TABLE subtitle_events (
  id bigserial PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES subtitle_attempts(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subtitle_events_attempt_idx ON subtitle_events (attempt_id, id);
