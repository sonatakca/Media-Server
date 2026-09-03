-- Titles published with part of the source replaced.
--
-- A disk with a bad region does not fail cleanly. The volume stays mounted,
-- every other byte of the file reads perfectly, and one stretch returns EIO for
-- ever. Under the `replace-epoch` policy the encoder substitutes black picture
-- and silence of exactly the planned length for that stretch, keeps the title's
-- own timeline, and publishes the rest — which means a `succeeded` row can now
-- describe two materially different things.
--
-- This column is what keeps them apart. It is NULL for every clean encode, and
-- an array of structured warnings for a salvaged one: which epoch, which
-- seconds of the source, how many reads were attempted, and what FFmpeg said.
-- Deliberately structured rather than folded into `warnings`, which is free
-- text: the page draws an interval from this, and an operator deciding whether
-- to re-rip a disc needs the figures rather than a sentence.
--
-- No path ever goes in here. The rows are served to a browser.

ALTER TABLE processing_jobs
  ADD COLUMN source_damage jsonb;

COMMENT ON COLUMN processing_jobs.source_damage IS
  'Intervals of the source that could not be read and were replaced with synthetic media. NULL means the encode was clean; a non-empty array means the title is salvaged and must not be presented as a perfect result.';

-- A salvaged title is rare and worth finding without scanning the table: an
-- operator asking "what did this failing drive cost me" wants all of them.
CREATE INDEX processing_jobs_source_damage_idx
  ON processing_jobs ((source_damage IS NOT NULL))
  WHERE source_damage IS NOT NULL;
