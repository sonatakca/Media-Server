-- A title somebody wants, before any of it is on disk.
--
-- Monitoring hangs off a catalogue item, and until now an item could only come
-- into being because a file was found. That is the right rule for a scanner —
-- it must never invent a title — but it left no way to express the thing
-- Radarr and Sonarr express constantly: *I want this, and I do not have it
-- yet.* Migrating away from them dropped roughly fifteen such intents on the
-- floor, because there was nowhere to put them.
--
-- The alternative was a second, parallel "wishlist" table. That would have
-- split identity in two: the wanted Oppenheimer and the Oppenheimer that
-- eventually lands would be different rows, and every consumer — monitoring,
-- profiles, search, acquisition, the UI — would have had to learn to look in
-- both and then reconcile them. Extending the item is what keeps a title one
-- thing for its whole life, from wanted, through acquired, to imported.

ALTER TABLE items
  -- True when the item exists because it is wanted rather than because a file
  -- was found. It says nothing about whether media is present: an item can be
  -- desired and fully downloaded at the same time, and stays desired so that
  -- deleting the file does not silently discard the intent.
  ADD COLUMN desired boolean NOT NULL DEFAULT false,
  -- When somebody asked for it. Distinct from `date_created`, which a rescan
  -- can reasonably reset, and useful for "how long have I been waiting".
  ADD COLUMN desired_since timestamptz;

COMMENT ON COLUMN items.desired IS
  'The item exists because it is wanted. Reconciliation never marks it missing '
  'or deletes it for having no files: it was never expected on disk. When the '
  'media does arrive the scan finds the same source_key and attaches files to '
  'this row, so monitoring, profile and history survive the acquisition.';

-- The wanted list, which is read far more often than it is written.
CREATE INDEX items_desired_idx
  ON items (library_id, kind)
  WHERE desired;
