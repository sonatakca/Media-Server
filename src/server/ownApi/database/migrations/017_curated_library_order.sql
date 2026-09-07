-- One order per library, shared by the library grid and its Latest row.
--
-- Migration 016 gave each shelf its own list, which meant the Latest films row
-- and the film library were ordered separately. In practice they are the same
-- decision made twice: somebody who drags a film to the front of the library
-- means it should lead the home row too, and nobody wants to do that work
-- twice and keep the two in agreement afterwards.
--
-- So the three `home-latest-*` surfaces go away and `library-grid` becomes
-- `library`: one list per library, read by both places. Its `hidden` flag stays
-- meaningful for exactly one of them — a title can be kept off the home row,
-- and can never be hidden from its own library, where hiding would only make
-- it unreachable.

-- Dropped rather than merged. There is no honest mapping from a home-latest
-- ordering onto a library's: the row held at most forty titles chosen by date,
-- so its sequence says nothing about the other nine hundred. Anyone who had
-- ordered that row re-does it once, on the library, and gets both.
DELETE FROM curated_lists WHERE surface LIKE 'home-latest-%';

ALTER TABLE curated_lists DROP CONSTRAINT curated_lists_surface_known;
ALTER TABLE curated_lists DROP CONSTRAINT curated_lists_library_scope;

UPDATE curated_lists SET surface = 'library' WHERE surface = 'library-grid';

ALTER TABLE curated_lists
  ADD CONSTRAINT curated_lists_surface_known
    CHECK (surface IN ('home-hero', 'library')),
  ADD CONSTRAINT curated_lists_library_scope
    CHECK ((surface = 'library') = (library_id IS NOT NULL));

COMMENT ON TABLE curated_lists IS
  'Server-side manual ordering. One row per library, read by both that library''s grid and its Latest row on the home page, plus one global row for the hero carousel.';
COMMENT ON COLUMN curated_list_entries.hidden IS
  'Keeps a title off the home page — the Latest row, or the hero carousel. Never hides it from its own library, where that would only make it unreachable.';
