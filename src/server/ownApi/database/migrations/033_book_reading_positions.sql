-- Where each reader stands in each book, so a book opened on another device
-- opens where it was left.
--
-- Kept apart from user_item_state: a film's place is one number in
-- milliseconds, a book's is a place in its text, and a book with a row in
-- user_item_state would start appearing among things to resume watching.

CREATE TABLE user_book_positions (
  user_id uuid NOT NULL REFERENCES native_users(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  -- The EPUB location of the first character on screen. NULL for a book read
  -- by scrolling a plain document (text, HTML), where only fraction applies.
  cfi text,
  -- Exactly where the screen stood: the first block still showing at its top
  -- (by spine section and block index) and how many px the top of the screen
  -- was below that block's top. Together, or not at all.
  section integer,
  block integer,
  block_offset integer,
  -- How far through the whole book, 0 to 1.
  fraction double precision NOT NULL,
  -- When the reader was at this place, by the reading device's clock and never
  -- later than the server's. A write older than the stored one loses, so a
  -- delayed save from a tab left open cannot pull the book back.
  read_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id),
  CONSTRAINT user_book_positions_fraction_range
    CHECK (fraction >= 0 AND fraction <= 1),
  CONSTRAINT user_book_positions_cfi_length
    CHECK (cfi IS NULL OR length(cfi) BETWEEN 1 AND 2048),
  CONSTRAINT user_book_positions_place_whole
    CHECK (
      (section IS NULL AND block IS NULL AND block_offset IS NULL)
      OR (section IS NOT NULL AND block IS NOT NULL AND block_offset IS NOT NULL)
    ),
  CONSTRAINT user_book_positions_place_range
    CHECK (
      section IS NULL
      OR (section >= 0 AND block >= 0 AND block_offset BETWEEN -1000000 AND 1000000)
    )
);

CREATE INDEX user_book_positions_item_idx ON user_book_positions (item_id);
