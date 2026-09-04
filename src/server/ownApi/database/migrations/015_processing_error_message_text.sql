-- Why a failure could erase its own cause.
--
-- `error_message` was `varchar(500)`, and the value written to it was whatever
-- the attempt had to say — for the pipeline's richer diagnoses, comfortably
-- more than five hundred characters. PostgreSQL does not truncate on overflow;
-- it rejects the statement. So the UPDATE that recorded *why* a job failed
-- failed itself, and the error that reached the row instead was the database's
-- own complaint about the column:
--
--   value too long for type character varying(500)
--
-- Five jobs in this deployment carry exactly that, and what they were really
-- doing when they died is not recorded anywhere. The rule that produced it is
-- worth stating plainly: a column narrow enough to reject a diagnostic makes
-- the diagnostic strictly less likely to survive the incident that produced it.
--
-- `text` costs nothing here. PostgreSQL stores it identically to `varchar`, and
-- the only thing the length cap ever bought was the failure above. The write
-- side keeps a generous ceiling of its own so a runaway message cannot grow
-- without bound; that ceiling is now the thing that trims, and it trims rather
-- than throwing.

ALTER TABLE processing_jobs
  ALTER COLUMN error_message TYPE text;

COMMENT ON COLUMN processing_jobs.error_message IS
  'Why the last attempt ended, as prose for an operator. Trimmed at the write to a generous ceiling; never rejected for length, because a rejected write replaces the diagnosis with a complaint about the column.';
