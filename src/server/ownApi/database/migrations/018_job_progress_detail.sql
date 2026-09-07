-- Structured progress for durable jobs.
--
-- `progress` and `progress_message` describe a job in a float and a sentence,
-- and the Library Maintenance page had to recover state by matching that
-- sentence with a regular expression — so the numbers it showed were a parse
-- of a label rather than a reading of the work. Worse, the float is a blend of
-- phases with no defensible relative cost, which is a percentage that cannot
-- be true.
--
-- This column carries what the executor actually knows: which phase, measured
-- how, with which counters, about which subject. It is additive and nullable:
-- rows written before it exist read as "no structured progress", and a server
-- that predates it ignores the column entirely.
--
-- `revision` inside the document is what makes an out-of-order write harmless;
-- the queue refuses any update whose revision does not exceed the stored one.
ALTER TABLE jobs
  ADD COLUMN progress_detail jsonb;

COMMENT ON COLUMN jobs.progress_detail IS
  'Structured phase/measure/counter progress for the current attempt. Null when the handler reports no structured progress. Monotonic in its own `revision` field.';
