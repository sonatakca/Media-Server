-- What the user wants acquired, and how good it has to be.
--
-- Two kinds of thing live here and they are deliberately kept apart. Policy —
-- profiles and preference rules — is durable, edited by a person, and small.
-- Monitoring state is durable too but derived from the library. Neither is a
-- search result: candidates are evaluated and discarded, and persisting every
-- one of them would be a table that grows with every search and answers no
-- question the indexer cannot answer again.

-- ---------------------------------------------------------------- profiles
--
-- `items` holds the ordered qualities. A profile position may name several
-- qualities at once, which is how the profiles being migrated are already
-- shaped, so the natural form is an array of arrays rather than a join table
-- with an ordering column that nothing else needs.
CREATE TABLE quality_profiles (
  id uuid PRIMARY KEY,
  name varchar(200) NOT NULL UNIQUE,
  -- [["webdl-1080p","bluray-1080p"], ["webdl-2160p"]] — worst first.
  items jsonb NOT NULL,
  cutoff_quality_id varchar(64) NOT NULL,
  -- Off by default, because every profile being migrated has it off and an
  -- upgrade is a second download and a second import of something already held.
  upgrade_allowed boolean NOT NULL DEFAULT false,
  min_format_score integer NOT NULL DEFAULT 0,
  cutoff_format_score integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ preferences
--
-- `conditions` is the rule's structured form. There is no pattern column and
-- no expression column: a saved regular expression would run against every
-- candidate of every future search, and one that backtracks catastrophically
-- would stall the process. Conditions match enumerated facts or plain
-- substrings, which cannot backtrack at all.
CREATE TABLE preference_rules (
  id uuid PRIMARY KEY,
  name varchar(200) NOT NULL UNIQUE,
  conditions jsonb NOT NULL,
  negate boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A rule is worth different amounts to different profiles — the same "x265
-- HEVC" rule scores 100 in two of the migrated profiles and 0 in the rest — so
-- the score belongs to the pairing, not to either side.
CREATE TABLE quality_profile_preferences (
  profile_id uuid NOT NULL REFERENCES quality_profiles(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES preference_rules(id) ON DELETE CASCADE,
  score integer NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, rule_id)
);

-- ------------------------------------------------------------- monitoring
--
-- One row per monitored item, movie or series alike. Sharing the table keeps
-- "is this monitored, and against which profile" a single question rather than
-- two tables that agree until they do not.
CREATE TABLE monitored_items (
  item_id uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  monitored boolean NOT NULL DEFAULT true,
  profile_id uuid REFERENCES quality_profiles(id) ON DELETE SET NULL,
  -- What is held right now, as the decision engine understands it. Null means
  -- nothing is held, which is a different thing from holding something unknown.
  current_quality_id varchar(64),
  current_format_score integer NOT NULL DEFAULT 0,
  last_evaluated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX monitored_items_monitored_idx
  ON monitored_items (monitored)
  WHERE monitored;

-- Season and episode monitoring is tri-state on purpose.
--
-- Three independent booleans cannot express "the series is monitored but this
-- season is not, except for one episode": whichever way the code resolves it,
-- the row itself does not record whether an unmonitored season was chosen or
-- merely inherited. `inherit` says "I have no opinion, ask my parent", so the
-- precedence is written down in the data rather than implied by the reader.
CREATE TYPE monitoring_choice AS ENUM ('inherit', 'monitored', 'unmonitored');

CREATE TABLE monitored_seasons (
  series_item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  season_number integer NOT NULL,
  monitoring monitoring_choice NOT NULL DEFAULT 'inherit',
  PRIMARY KEY (series_item_id, season_number)
);

CREATE TABLE monitored_episodes (
  series_item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  season_number integer NOT NULL,
  episode_number integer NOT NULL,
  monitoring monitoring_choice NOT NULL DEFAULT 'inherit',
  -- Null means the air date is unknown, not that it has not aired. An episode
  -- that has not aired cannot be missing, so the two must stay distinguishable.
  aired_at timestamptz,
  current_quality_id varchar(64),
  current_format_score integer NOT NULL DEFAULT 0,
  PRIMARY KEY (series_item_id, season_number, episode_number)
);

CREATE INDEX monitored_episodes_series_idx
  ON monitored_episodes (series_item_id, season_number);

COMMENT ON TYPE monitoring_choice IS
  'inherit defers to the parent season, then to the series. It exists so that '
  'precedence is recorded in the row rather than inferred by whoever reads it.';
