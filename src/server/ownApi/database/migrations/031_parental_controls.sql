-- Parental controls: the oldest age rating a viewer may see.
--
-- A rating is kept as the board wrote it — "13+", "PG-13", "TV-MA",
-- "Genel İzleyici" — because that is what a person reads on the page. Only
-- the question "how old must the viewer be" is normalised, here, in the one
-- function every visibility check calls, so a board nobody anticipated is a
-- change to this function and not to every query.
--
-- NULL means the rating says nothing usable: unrated, "NR", or a spelling
-- this does not know. What an unrated title means for a restricted viewer is
-- the viewer's own setting, not this function's guess.

CREATE FUNCTION seyirlik_rating_age(rating text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN normalized IS NULL OR normalized = '' THEN NULL
    WHEN normalized IN ('NR', 'NOT RATED', 'UNRATED', 'UR', 'N/A') THEN NULL
    -- Everyone.
    WHEN normalized IN ('G', 'U', 'TV-Y', 'TV-G', 'ALL', 'GENEL', 'GENEL İZLEYICI',
                        'GENEL IZLEYICI', 'GENEL İZLEYİCİ', 'E', 'AL', 'TP')
      THEN 0
    -- American boards.
    WHEN normalized IN ('TV-Y7', 'TV-Y7-FV') THEN 7
    WHEN normalized IN ('PG', 'TV-PG') THEN 10
    WHEN normalized IN ('PG-13', '12A') THEN 13
    WHEN normalized = 'TV-14' THEN 14
    WHEN normalized IN ('R', 'TV-MA') THEN 17
    WHEN normalized IN ('NC-17', 'X', 'R18') THEN 18
    -- Anything that states an age outright: "13+", "FSK 16", "TR-18", "7A".
    WHEN normalized ~ '(^|[^0-9])[0-9]{1,2}([^0-9]|$)'
      THEN substring(normalized from '([0-9]{1,2})')::integer
    ELSE NULL
  END
  FROM (SELECT upper(btrim(rating)) AS normalized) AS input
$$;

ALTER TABLE native_users
  ADD COLUMN max_content_age integer,
  ADD COLUMN allow_unrated_content boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT native_users_max_content_age_range
    CHECK (max_content_age IS NULL OR max_content_age BETWEEN 0 AND 21);

COMMENT ON COLUMN native_users.max_content_age IS
  'Oldest rating age this viewer may see; NULL is no limit.';
COMMENT ON COLUMN native_users.allow_unrated_content IS
  'Whether a viewer with a limit may see titles no board has rated.';
