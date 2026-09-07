-- Trickplay sheets moved out of a central UUID tree and into the title folder
-- they belong to, beside `video/`, `audio/`, `subtitle/` and `content/`.
--
-- `storage_prefix` was the address of a directory under
-- `<generated storage>/trickplay/<uuid>/`. A title-owned set has no such
-- address: it is derived from the media file's own source path, so the row no
-- longer records where the bytes are and cannot disagree with the filesystem
-- about it.
--
-- The column is kept, and made nullable, rather than dropped. It is now the one
-- thing that distinguishes a set still living in the old tree from a migrated
-- one:
--
--   storage_prefix IS NOT NULL  ->  legacy: bytes under <generated>/trickplay/<uuid>
--   storage_prefix IS NULL      ->  current: bytes under <titleRoot>/trickplay/
--
-- The migration command clears it per set, one set at a time, only after that
-- set's bytes have been copied into the title folder and verified there. Until
-- every row is null the server must be able to serve both, which is exactly
-- what a nullable column expresses. It can be dropped once no rows carry one.

ALTER TABLE trickplay_sets
  ALTER COLUMN storage_prefix DROP NOT NULL;

COMMENT ON COLUMN trickplay_sets.storage_prefix IS
  'Legacy UUID directory under <generated storage>/trickplay. NULL means the '
  'set lives at <titleRoot>/trickplay, which is where every new set is written.';
