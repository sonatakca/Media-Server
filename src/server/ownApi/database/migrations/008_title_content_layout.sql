-- A title's upright poster is its cover. Keep that name consistent from the
-- database through the native DTO and its on-disk content/cover.jpg file.
--
-- A title owns one landscape backdrop. Older metadata refreshes retained up to
-- five provider alternatives; those were never distinct display roles and do
-- not belong in the canonical title layout.

ALTER TABLE item_images
  DROP CONSTRAINT item_images_type_known;

UPDATE item_images
SET image_type = 'cover'
WHERE image_type = 'primary';

DELETE FROM item_images
WHERE image_type = 'backdrop' AND image_index > 0;

ALTER TABLE item_images
  ADD CONSTRAINT item_images_type_known
  CHECK (image_type IN ('cover', 'backdrop', 'logo', 'thumb', 'banner', 'chapter'));
