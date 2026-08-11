-- Fine placement of a title's logo on its card, replacing three presets.
--
-- Fractions of the card rather than pixels: the same card is drawn as a poster
-- in the grid and as a wide tile in Continue Watching, and a layout chosen at
-- one size has to hold at the others. `x`/`y` locate the centre of the logo.
--
-- All three are nullable together, and null means "draw the card the way it has
-- always been drawn" — which is not the same as any particular set of numbers,
-- so it cannot be expressed as a default.
ALTER TABLE items
  ADD COLUMN logo_offset_x real,
  ADD COLUMN logo_offset_y real,
  ADD COLUMN logo_width real;

-- The presets become the positions they stood for, so nobody loses a choice
-- they already made. `bottom` was the untouched look, so it stays unset.
UPDATE items
   SET logo_offset_x = 0.5,
       logo_offset_y = CASE logo_placement WHEN 'top' THEN 0.14 ELSE 0.5 END,
       logo_width = 0.74
 WHERE logo_placement IN ('top', 'middle');

ALTER TABLE items DROP COLUMN logo_placement;

ALTER TABLE items
  ADD CONSTRAINT items_logo_layout_complete
    CHECK (
      (logo_offset_x IS NULL AND logo_offset_y IS NULL AND logo_width IS NULL)
      OR (logo_offset_x IS NOT NULL AND logo_offset_y IS NOT NULL AND logo_width IS NOT NULL)
    );

ALTER TABLE items
  ADD CONSTRAINT items_logo_layout_in_range
    CHECK (
      (logo_offset_x IS NULL)
      OR (
        logo_offset_x BETWEEN 0 AND 1
        AND logo_offset_y BETWEEN 0 AND 1
        AND logo_width BETWEEN 0.15 AND 1
      )
    );
