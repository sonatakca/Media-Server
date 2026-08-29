-- Pausing a processing job, and surviving the storage going away.
--
-- `paused` was already a legal state but nothing could ask for it: the runner
-- only ever polled `cancellation_requested`, so the single way to stop a job
-- was to lose all of its work. A pause request is modelled the same way as a
-- cancellation request — a flag the running job polls — because that is the
-- only channel that reaches a worker in another process.

ALTER TABLE processing_jobs
  ADD COLUMN pause_requested boolean NOT NULL DEFAULT false;

-- Why a job is paused, so the UI can say "waiting for the drive" rather than
-- leaving an operator to guess whether they paused it themselves. Null while
-- the job is not paused.
ALTER TABLE processing_jobs
  ADD COLUMN paused_reason text;

ALTER TABLE processing_jobs
  ADD CONSTRAINT processing_jobs_paused_reason_known
  CHECK (paused_reason IS NULL OR paused_reason IN ('operator', 'storage-unavailable'));

-- A job paused because the drive vanished is resumable the moment it returns,
-- so it must stay findable without scanning the whole table.
CREATE INDEX processing_jobs_paused_reason_idx
  ON processing_jobs (paused_reason)
  WHERE paused_reason IS NOT NULL;
