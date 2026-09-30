-- Which films belong to which collection.
--
-- A collection is an ordinary item of kind 'collection', so every read surface
-- that already lists, shows and grants access to items handles it unchanged.
-- Membership is not `parent_id`: that column belongs to the scanner, which
-- derives it from folders and resets it on every reconcile, and a film's box
-- set is a fact about the film from the metadata provider, not about where the
-- file sits. One film belongs to at most one collection, as on TMDB.

CREATE TABLE collection_members (
  collection_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, item_id),
  UNIQUE (item_id)
);

CREATE INDEX collection_members_collection_idx ON collection_members (collection_id);
