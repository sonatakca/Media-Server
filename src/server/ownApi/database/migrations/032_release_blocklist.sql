-- Releases that must never be chosen again, and how large a release may be.
--
-- A release that failed for a reason the release itself owns — missing
-- articles, a password, a broken repair — will fail the same way next time.
-- Without a record of that, the decision engine has no way to know, and the
-- next search recommends the same broken upload as confidently as the first.

CREATE TABLE release_blocklist (
  id uuid PRIMARY KEY,
  indexer_id varchar(64) NOT NULL,
  release_guid text NOT NULL,
  -- Matched as well as the guid: the same upload is routinely listed by more
  -- than one indexer under different guids, and it is just as broken on each.
  release_title text NOT NULL,
  target_kind text,
  target_title varchar(500),
  reason text,
  -- Which acquisition it came from, when it came from one. Kept when that row
  -- goes, because the blocklisting outlives the download that prompted it.
  acquisition_id uuid REFERENCES acquisitions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (indexer_id, release_guid)
);

CREATE INDEX release_blocklist_title_idx
  ON release_blocklist (lower(release_title));

-- The largest release a profile will accept, in bytes. NULL means no limit.
--
-- Defaulted rather than left open: a 2160p remux runs to 60–90 GB, and nothing
-- the profiles being migrated rank as better is worth that much disk. Existing
-- profiles take the default too, which is the point.
ALTER TABLE quality_profiles
  ADD COLUMN max_size_bytes bigint DEFAULT 30000000000
  CHECK (max_size_bytes IS NULL OR max_size_bytes > 0);

COMMENT ON TABLE release_blocklist IS
  'Releases the decision engine rejects outright, matched by indexer and guid '
  'or by exact release title.';
