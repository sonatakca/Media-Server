-- How strongly a title's logo is shadowed on its card.
--
-- A logo over a dark, quiet poster needs almost nothing; the same logo over a
-- bright sky needs a great deal. 0 turns the shadow off entirely, which is the
-- right answer for a logo that already carries its own outline.
--
-- Part of the layout rather than a setting of its own: it is adjusted while
-- looking at the same picture, and cleared when the layout is cleared.
ALTER TABLE items ADD COLUMN logo_shadow real;

-- Titles adjusted before this existed keep the shadow they were drawn with.
UPDATE items SET logo_shadow = 1 WHERE logo_offset_x IS NOT NULL;

ALTER TABLE items DROP CONSTRAINT items_logo_layout_complete;

ALTER TABLE items
  ADD CONSTRAINT items_logo_layout_complete
    CHECK (
      (logo_offset_x IS NULL AND logo_offset_y IS NULL
        AND logo_width IS NULL AND logo_shadow IS NULL)
      OR (logo_offset_x IS NOT NULL AND logo_offset_y IS NOT NULL
        AND logo_width IS NOT NULL AND logo_shadow IS NOT NULL)
    );

ALTER TABLE items
  ADD CONSTRAINT items_logo_shadow_in_range
    CHECK (logo_shadow IS NULL OR logo_shadow BETWEEN 0 AND 2);
