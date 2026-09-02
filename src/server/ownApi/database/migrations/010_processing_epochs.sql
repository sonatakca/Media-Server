-- Durable five-minute encoding epochs.
--
-- A processing job used to be one transaction: the encoder either produced the
-- whole ladder or produced nothing worth keeping. It now works through the
-- timeline in nominal five-minute epochs, each of which becomes an immutable
-- checkpoint on disk the moment it validates. The database does not own those
-- checkpoints — the filesystem does, because it is the only thing that survives
-- a machine losing power — but it does have to be able to *describe* them, so
-- that a page opened after a restart can say how much work is protected without
-- waiting for the encoder to report in.
--
-- Every column here is therefore a cached view of what is on disk, not a source
-- of truth. Reconciliation always reads the checkpoints.

ALTER TABLE processing_jobs
  -- How many epochs the immutable plan contains, and which one is running.
  ADD COLUMN epoch_count integer,
  ADD COLUMN epoch_index integer,
  -- Epochs whose checkpoints are durable. Distinct from `epoch_index`: after a
  -- corrupted checkpoint is rebuilt these move independently.
  ADD COLUMN completed_epochs integer NOT NULL DEFAULT 0,
  -- Media time that would survive the machine losing power right now.
  ADD COLUMN protected_seconds double precision NOT NULL DEFAULT 0,
  -- Media time encoded, protected plus the epoch in flight. This is the figure
  -- the progress percentage is derived from; the old `overall_progress` remains
  -- a whole-workflow figure and must never be shown as encoding progress.
  ADD COLUMN encoded_seconds double precision NOT NULL DEFAULT 0,
  ADD COLUMN source_duration_seconds double precision,
  -- The running epoch's window on the source timeline, so the page can say
  -- "00:50:00 → 00:55:00" rather than "epoch 11".
  ADD COLUMN epoch_start_seconds double precision,
  ADD COLUMN epoch_end_seconds double precision,
  -- Bytes of encoded media that are protected by checkpoints. Shown next to the
  -- free space so an operator can see what a cleanup would be throwing away.
  ADD COLUMN checkpoint_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN free_bytes bigint;

-- A job's epoch position is read on every page refresh and every live-stream
-- tick, always by id, so no index is needed beyond the primary key.

COMMENT ON COLUMN processing_jobs.protected_seconds IS
  'Media time covered by durable checkpoints; a crash cannot cost more than what lies beyond it.';
COMMENT ON COLUMN processing_jobs.encoded_seconds IS
  'Media time actually encoded. The video progress percentage is this divided by source_duration_seconds.';
