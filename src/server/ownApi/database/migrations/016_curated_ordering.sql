-- Hand-placed ordering for the shelves a person actually looks at.
--
-- Until now every list on the site derived its order from a property of the
-- title: `sort_title` for the library grids, `date_created` for the Latest
-- rows, an artwork-completeness score for the hero carousel. None of those can
-- express "this one goes first because I say so", and the one manual ordering
-- that did exist lived in `localStorage`, which meant it was a different order
-- on the phone, on the TV, and for every other person in the house.
--
-- These tables move that decision to the server, where there is one answer.

CREATE TABLE curated_lists (
  id uuid PRIMARY KEY,
  -- Which shelf this ordering belongs to. Constrained rather than free text:
  -- a typo in a surface name would silently create a second, invisible list
  -- that no page ever reads.
  surface text NOT NULL,
  -- Set for library grids, which exist once per library, and null for the home
  -- shelves, which exist once in total. The check below keeps those two shapes
  -- from being confused; the cascade drops a library's ordering with the
  -- library rather than leaving it to point at nothing.
  library_id uuid REFERENCES libraries(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Who last saved it. Nulled rather than cascaded on user deletion: the
  -- ordering is the house's, not the person's, and must outlive the account.
  updated_by uuid REFERENCES native_users(id) ON DELETE SET NULL,
  CONSTRAINT curated_lists_surface_known CHECK (surface IN (
    'home-hero',
    'home-latest-movies',
    'home-latest-shows',
    'home-latest-books',
    'library-grid'
  )),
  CONSTRAINT curated_lists_library_scope
    CHECK ((surface = 'library-grid') = (library_id IS NOT NULL))
);

-- One list per shelf, enforced in the two shapes separately because NULL does
-- not compare equal to itself: a plain UNIQUE (surface, library_id) would
-- happily admit a second 'home-hero' row.
CREATE UNIQUE INDEX curated_lists_home_surface_idx
  ON curated_lists (surface) WHERE library_id IS NULL;
CREATE UNIQUE INDEX curated_lists_library_surface_idx
  ON curated_lists (surface, library_id) WHERE library_id IS NOT NULL;

CREATE TABLE curated_list_entries (
  list_id uuid NOT NULL REFERENCES curated_lists(id) ON DELETE CASCADE,
  -- A title that leaves the catalogue leaves the ordering with it. Without the
  -- cascade a rescan that dropped a film would leave a hole that the editor
  -- could neither see nor remove.
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position integer NOT NULL,
  -- Only the home shelves honour this; the library grids ignore it, because
  -- hiding a title from its own library would make it unreachable rather than
  -- unobtrusive.
  hidden boolean NOT NULL DEFAULT false,
  PRIMARY KEY (list_id, item_id),
  CONSTRAINT curated_list_entries_position_nonnegative CHECK (position >= 0)
);

-- Positions are dense and unique within a list. A save rewrites the whole list
-- inside one transaction, so this can be a plain unique index: there is never a
-- moment between two statements where two rows share a position.
CREATE UNIQUE INDEX curated_list_entries_position_idx
  ON curated_list_entries (list_id, position);

COMMENT ON TABLE curated_lists IS
  'Server-side manual ordering for the home shelves and the library grids. One row per shelf; the entries carry the order.';
COMMENT ON COLUMN curated_list_entries.position IS
  'Dense 0-based rank within the list. Titles with no entry sort after every entry, in the shelf''s own default order.';
