-- Which scratch volume a job's workspace was claimed on.
--
-- The in-process guard binds a running job to `st_dev`, and that is the right
-- answer while the process lives: it is one `stat`, and it catches the case a
-- path test cannot — an unmounted volume whose mountpoint pathname has been
-- recreated on the filesystem underneath it.
--
-- It cannot answer anything after a restart. `st_dev` is a mount slot, not a
-- volume: detaching one disk and attaching another hands the second the number
-- the first had, and reattaching the first gives it a new one. It is therefore
-- deliberately never persisted, here or anywhere else.
--
-- The workspace's own `.seyirlik-job.json` marker cannot answer either, and for
-- a more basic reason: it lives *on* the scratch volume, so it is missing in
-- precisely the situation that needs an answer — the disk is absent, and the
-- pathname now resolves to the parent filesystem, where a fresh marker could be
-- written and a fresh workspace begun on the wrong disk.
--
-- So the expected volume is recorded here, off the volume it describes, and a
-- resuming job compares what is mounted against it before creating anything.

ALTER TABLE processing_jobs
  -- The volume's own UUID: survives unmount, remount and reboot. The only
  -- durable identity, and the one recovery matches on.
  ADD COLUMN scratch_volume_uuid varchar(64),
  -- physical-external | physical-internal | disk-image | network | unknown.
  -- Necessary, never sufficient: it is what catches a disk image standing in
  -- for the physical drive the job was actually using.
  ADD COLUMN scratch_volume_medium varchar(32),
  -- Recorded because a reformat is a different filesystem wearing the same name.
  ADD COLUMN scratch_volume_fs_type varchar(32);

COMMENT ON COLUMN processing_jobs.scratch_volume_uuid IS
  'Authoritative scratch identity across restarts. NULL means the job never claimed a workspace on an identifiable volume, and it is then treated as a new job.';
COMMENT ON COLUMN processing_jobs.scratch_volume_medium IS
  'Checked before the UUID: a disk image is never the physical drive a job was running on, whatever it calls itself.';

-- Existing rows keep NULL, which is the safe direction and preserves exactly
-- the behaviour that shipped before this column: a job with no recorded scratch
-- identity claims its workspace the way a new job does.
