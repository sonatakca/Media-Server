-- Native catalogue: libraries, logical items, physical files, technical streams.
--
-- Logical items are deliberately separated from files so that a title survives a
-- re-encode, a rename, or a temporary unmount without losing user state.

CREATE TABLE libraries (
  id uuid PRIMARY KEY,
  slug varchar(64) NOT NULL UNIQUE,
  name varchar(200) NOT NULL,
  kind text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT libraries_kind_known
    CHECK (kind IN ('movies', 'series', 'books', 'collections', 'mixed')),
  CONSTRAINT libraries_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT libraries_slug_syntax CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$')
);

CREATE TABLE library_roots (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  -- Relative to SEYIRLIK_MEDIA_ROOT. Absolute paths are never stored so that a
  -- database dump can never leak the host filesystem layout.
  relative_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_roots_relative CHECK (relative_path !~ '^[/\\]' AND relative_path !~ '(^|/)\.\.(/|$)'),
  UNIQUE (library_id, relative_path)
);

-- Per-user library visibility. A user with no rows here sees every library only
-- when allow_all_libraries is set on the user; otherwise they see nothing.
CREATE TABLE user_library_permissions (
  user_id uuid NOT NULL REFERENCES native_users(id) ON DELETE CASCADE,
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, library_id)
);

ALTER TABLE native_users
  ADD COLUMN allow_all_libraries boolean NOT NULL DEFAULT true,
  ADD COLUMN allow_playback boolean NOT NULL DEFAULT true,
  ADD COLUMN allow_downloads boolean NOT NULL DEFAULT false;

CREATE TABLE items (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES items(id) ON DELETE CASCADE,
  series_id uuid REFERENCES items(id) ON DELETE CASCADE,
  kind text NOT NULL,
  -- Stable identity derived from the on-disk location, so a rescan re-attaches
  -- user state to the same logical item instead of creating a duplicate.
  source_key text NOT NULL,
  title varchar(500) NOT NULL,
  sort_title varchar(500) NOT NULL,
  original_title varchar(500),
  overview text,
  tagline varchar(500),
  production_year integer,
  premiere_date timestamptz,
  end_date timestamptz,
  official_rating varchar(32),
  community_rating real,
  runtime_ms bigint,
  index_number integer,
  parent_index_number integer,
  provider_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  locked_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata_state text NOT NULL DEFAULT 'pending',
  metadata_refreshed_at timestamptz,
  child_count integer NOT NULL DEFAULT 0,
  recursive_item_count integer NOT NULL DEFAULT 0,
  date_created timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Reconciliation bookkeeping: an item whose files all vanished is retained for
  -- a grace period so an unmounted volume does not destroy watch history.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  missing_since timestamptz,
  CONSTRAINT items_kind_known
    CHECK (kind IN ('movie', 'series', 'season', 'episode', 'book', 'collection', 'trailer')),
  CONSTRAINT items_title_nonempty CHECK (length(btrim(title)) > 0),
  CONSTRAINT items_metadata_state_known
    CHECK (metadata_state IN ('pending', 'matched', 'unmatched', 'locked', 'failed')),
  CONSTRAINT items_production_year_range
    CHECK (production_year IS NULL OR (production_year BETWEEN 1870 AND 2200)),
  CONSTRAINT items_runtime_nonnegative CHECK (runtime_ms IS NULL OR runtime_ms >= 0),
  UNIQUE (library_id, source_key)
);

CREATE INDEX items_library_kind_sort_idx ON items (library_id, kind, sort_title);
CREATE INDEX items_parent_idx ON items (parent_id, index_number);
CREATE INDEX items_series_idx ON items (series_id, parent_index_number, index_number);
CREATE INDEX items_kind_created_idx ON items (kind, date_created DESC);
CREATE INDEX items_provider_ids_idx ON items USING gin (provider_ids jsonb_path_ops);
CREATE INDEX items_missing_idx ON items (missing_since) WHERE missing_since IS NOT NULL;

-- Trigram-free prefix/substring search that still uses an index for the common
-- "starts with" case; full substring search falls back to a sequential scan on a
-- library-scoped subset, which is acceptable at personal-library cardinality.
CREATE INDEX items_search_title_idx ON items (lower(title) varchar_pattern_ops);

CREATE TABLE media_files (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  relative_path text NOT NULL UNIQUE,
  container varchar(64),
  size_bytes bigint NOT NULL,
  mtime_ms bigint NOT NULL,
  -- size + mtime + path. Cheap, stable enough to invalidate probe results
  -- without hashing terabytes of video on every scan.
  fingerprint text NOT NULL,
  duration_ms bigint,
  bitrate_bps bigint,
  is_primary boolean NOT NULL DEFAULT true,
  probe_state text NOT NULL DEFAULT 'pending',
  probed_at timestamptz,
  probe_error text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  missing_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_files_relative CHECK (relative_path !~ '^[/\\]' AND relative_path !~ '(^|/)\.\.(/|$)'),
  CONSTRAINT media_files_size_nonnegative CHECK (size_bytes >= 0),
  CONSTRAINT media_files_probe_state_known
    CHECK (probe_state IN ('pending', 'probed', 'failed'))
);

CREATE INDEX media_files_item_idx ON media_files (item_id, is_primary DESC);
CREATE INDEX media_files_probe_pending_idx ON media_files (probe_state) WHERE probe_state = 'pending';
CREATE INDEX media_files_fingerprint_idx ON media_files (fingerprint);

CREATE TABLE media_streams (
  media_file_id uuid NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  stream_index integer NOT NULL,
  kind text NOT NULL,
  codec varchar(64),
  profile varchar(64),
  level integer,
  language varchar(16),
  title varchar(300),
  is_default boolean NOT NULL DEFAULT false,
  is_forced boolean NOT NULL DEFAULT false,
  is_external boolean NOT NULL DEFAULT false,
  is_text_subtitle boolean NOT NULL DEFAULT false,
  external_relative_path text,
  channels integer,
  sample_rate integer,
  bitrate_bps bigint,
  width integer,
  height integer,
  pixel_format varchar(32),
  frame_rate real,
  video_range varchar(32),
  color_transfer varchar(64),
  color_primaries varchar(64),
  color_space varchar(64),
  bit_depth integer,
  PRIMARY KEY (media_file_id, stream_index),
  CONSTRAINT media_streams_kind_known
    CHECK (kind IN ('video', 'audio', 'subtitle', 'attachment', 'data')),
  CONSTRAINT media_streams_external_path
    CHECK (external_relative_path IS NULL OR external_relative_path !~ '^[/\\]')
);

CREATE INDEX media_streams_kind_idx ON media_streams (media_file_id, kind, stream_index);

CREATE TABLE item_chapters (
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  chapter_index integer NOT NULL,
  start_ms bigint NOT NULL,
  name varchar(300),
  PRIMARY KEY (item_id, chapter_index),
  CONSTRAINT item_chapters_start_nonnegative CHECK (start_ms >= 0)
);

CREATE TABLE genres (
  id uuid PRIMARY KEY,
  name varchar(120) NOT NULL,
  normalized_name varchar(120) NOT NULL UNIQUE
);

CREATE TABLE item_genres (
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  genre_id uuid NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, genre_id)
);

CREATE INDEX item_genres_genre_idx ON item_genres (genre_id);

CREATE TABLE people (
  id uuid PRIMARY KEY,
  name varchar(300) NOT NULL,
  normalized_name varchar(300) NOT NULL,
  provider_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (normalized_name)
);

CREATE TABLE item_people (
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role text NOT NULL,
  character_name varchar(300),
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, person_id, role),
  CONSTRAINT item_people_role_known
    CHECK (role IN ('actor', 'director', 'writer', 'producer', 'composer', 'guest'))
);

CREATE INDEX item_people_person_idx ON item_people (person_id);

-- Cached artwork. Bytes live on the generated-storage volume; the row is the
-- authorization and cache-validation record.
CREATE TABLE item_images (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  image_type text NOT NULL,
  image_index integer NOT NULL DEFAULT 0,
  content_hash varchar(64) NOT NULL,
  content_type varchar(64) NOT NULL,
  width integer,
  height integer,
  size_bytes bigint NOT NULL,
  storage_key text NOT NULL,
  source text NOT NULL,
  source_url text,
  is_locked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_images_type_known
    CHECK (image_type IN ('primary', 'backdrop', 'logo', 'thumb', 'banner', 'chapter')),
  CONSTRAINT item_images_source_known
    CHECK (source IN ('tmdb', 'sidecar', 'embedded', 'generated', 'upload')),
  CONSTRAINT item_images_content_type_known
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  UNIQUE (item_id, image_type, image_index)
);

CREATE INDEX item_images_lookup_idx ON item_images (item_id, image_type, image_index);
CREATE INDEX item_images_hash_idx ON item_images (content_hash);

CREATE TABLE item_segments (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  segment_type text NOT NULL,
  start_ms bigint NOT NULL,
  end_ms bigint NOT NULL,
  source text NOT NULL DEFAULT 'detected',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_segments_type_known
    CHECK (segment_type IN ('intro', 'outro', 'recap', 'preview', 'commercial')),
  CONSTRAINT item_segments_source_known
    CHECK (source IN ('detected', 'manual', 'chapter')),
  CONSTRAINT item_segments_range CHECK (start_ms >= 0 AND end_ms > start_ms),
  UNIQUE (item_id, segment_type, start_ms)
);

CREATE INDEX item_segments_item_idx ON item_segments (item_id, start_ms);

CREATE TABLE trickplay_sets (
  id uuid PRIMARY KEY,
  media_file_id uuid NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  tile_width integer NOT NULL,
  tile_height integer NOT NULL,
  columns integer NOT NULL,
  rows integer NOT NULL,
  interval_ms integer NOT NULL,
  thumbnail_count integer NOT NULL,
  sprite_count integer NOT NULL,
  storage_prefix text NOT NULL,
  content_type varchar(64) NOT NULL DEFAULT 'image/jpeg',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trickplay_positive
    CHECK (tile_width > 0 AND tile_height > 0 AND columns > 0 AND rows > 0
           AND interval_ms > 0 AND thumbnail_count >= 0 AND sprite_count >= 0),
  UNIQUE (media_file_id, tile_width)
);
