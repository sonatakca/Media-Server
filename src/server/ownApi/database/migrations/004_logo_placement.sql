-- Where a title's logo sits over its artwork.
--
-- Logos are wildly inconsistent in shape: a wide wordmark and a tall stacked
-- crest want different vertical anchors over the same backdrop, and no single
-- placement flatters both. This is an operator's per-title choice.
--
-- The default is 'bottom' because that is where every logo already sat, so
-- applying this migration changes nothing about how anything looks.
ALTER TABLE items
  ADD COLUMN logo_placement text NOT NULL DEFAULT 'bottom';

ALTER TABLE items
  ADD CONSTRAINT items_logo_placement_known
    CHECK (logo_placement IN ('top', 'middle', 'bottom'));
