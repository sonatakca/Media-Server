-- A source file that packaging has replaced.
--
-- Once a title is fully processed its adaptive package is complete and the
-- source bytes are removed. The catalogue keeps the source's media_files row on
-- purpose — playback and adaptive-asset authorization resolve through it — but
-- nothing recorded why that row's file was gone. The prober then found no file,
-- marked it `failed`, and the availability rule (which excludes failed probes)
-- dropped a fully playable film from every browse page and showed it to the
-- administrator as merely wanted. On Windows that was 11 titles, Dune and the
-- first Arcane episode among them.
--
-- `packaged` is the scanner's own finding: it has just verified the title's
-- package is complete. It is not `probed` — no stream was read — and it is not
-- `failed` — nothing is wrong. The prober only takes `pending` rows, so it will
-- not overwrite it; a changed source is re-queued as `pending` as before.

ALTER TABLE media_files DROP CONSTRAINT media_files_probe_state_known;
ALTER TABLE media_files ADD CONSTRAINT media_files_probe_state_known
  CHECK (probe_state IN ('pending', 'probed', 'failed', 'packaged'));
