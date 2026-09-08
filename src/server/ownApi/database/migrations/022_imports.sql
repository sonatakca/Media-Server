-- An import: moving a finished download into the library, durably enough that
-- a crash at any point converges on one answer.
--
-- The shape of this table follows from one fact. An import is a transaction
-- across two systems that cannot commit together — a filesystem and this
-- database — so the row's job is not to describe the work but to record enough
-- evidence that a process which has just restarted can find out what actually
-- happened and finish it exactly once.

CREATE TABLE imports (
  id uuid PRIMARY KEY,

  -- Where the handoff came from. Nullable because an operator may import
  -- something Seyirlik did not download.
  acquisition_id uuid REFERENCES acquisitions(id) ON DELETE SET NULL,

  /*
   * The durable identity, generated with the row and never derived again.
   *
   * It names the staging artifacts on disk, so a restart can recognise its own
   * half-finished work — and, being unique, it is what stops the same handoff
   * being turned into two imports by two workers.
   */
  idempotency_key varchar(128) NOT NULL UNIQUE,

  -- What the library will hold when this succeeds.
  target_kind text NOT NULL,
  target_item_id uuid REFERENCES items(id) ON DELETE SET NULL,
  target_title varchar(500) NOT NULL,
  target_year integer,
  target_season integer,
  target_episode integer,

  /*
   * The two roots this import was authorised against, recorded at plan time
   * rather than read from configuration when the work runs.
   *
   * Configuration can be edited between planning and committing, and an
   * in-flight import that picked up a new library root would write somewhere
   * nobody authorised. Containment is therefore re-proven on every operation
   * against these two values, not against whatever the settings now say.
   */
  source_root text NOT NULL,
  library_root text NOT NULL,
  -- Relative to source_root: a download directory, or a single file in one.
  source_relative text NOT NULL,

  state text NOT NULL,
  -- hardlink | copy | move. Null until the filesystem has been asked what it
  -- supports; recorded because the safe recovery differs for each.
  strategy text,

  attempt integer NOT NULL DEFAULT 0,
  failure_class text,
  failure_detail text,
  retry_after timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- When the destination became durable. Distinct from completed_at: an import
  -- is committed before cleanup runs, and cleanup cannot un-commit it.
  committed_at timestamptz,
  completed_at timestamptz
);

-- The worker asks for exactly this set.
CREATE INDEX imports_active_idx
  ON imports (state)
  WHERE state NOT IN ('complete', 'cancelled', 'failed');

-- Reconciliation asks for exactly this set: the rows whose filesystem outcome
-- is unknown and must be read before anything else is done to them.
CREATE INDEX imports_uncertain_idx
  ON imports (state)
  WHERE state IN ('committing', 'uncertain');

CREATE INDEX imports_acquisition_idx ON imports (acquisition_id);
CREATE INDEX imports_target_idx ON imports (target_item_id);

-- One handoff becomes one import. Two workers reading the same completed
-- acquisition cannot both create one.
CREATE UNIQUE INDEX imports_one_per_acquisition_idx
  ON imports (acquisition_id)
  WHERE acquisition_id IS NOT NULL
    AND state NOT IN ('failed', 'cancelled');

-- Every file the import decided about, whether or not it is moved.
--
-- A release is rarely one file, and the outcome is per-file: a subtitle that
-- fails to link must not make the feature it belongs to disappear, and it must
-- not let the import claim it finished either.
CREATE TABLE import_files (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES imports(id) ON DELETE CASCADE,

  -- media | subtitle | metadata | artwork | sample | trailer | extra |
  -- ignored | unclaimed. Only the first three are moved.
  role text NOT NULL,
  source_relative text NOT NULL,
  -- Relative to the import's library_root. Null for roles left where they are.
  destination_relative text,

  /*
   * The destination, normalised and case-folded, as one string.
   *
   * Case-folded because the library lives on a case-insensitive filesystem,
   * where `Dune (2021).mkv` and `dune (2021).MKV` are one file. Storing the
   * folded form is what lets the unique index below refuse a collision that a
   * case-sensitive comparison would have waved through.
   */
  destination_key text,

  state text NOT NULL,
  strategy text,

  size_bytes bigint,
  source_mtime_ms bigint,
  /*
   * Evidence that the file at the destination is the one this import put
   * there, rather than something unrelated that happens to have the same name.
   *
   * Filesystem identity where the platform gives one, so recovery after an
   * ambiguous commit can tell "we already did this" from "something else lives
   * here" without hashing the file.
   */
  destination_identity text,

  failure_class text,
  failure_detail text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One import cannot plan two files onto one destination.
  UNIQUE (import_id, destination_key)
);

CREATE INDEX import_files_import_idx ON import_files (import_id);

/*
 * At most one committed file per destination, across every import.
 *
 * This is the invariant that makes "the same import run twice produces one
 * library object" a property of the database rather than a property of the
 * code being careful. Two workers racing to commit the same destination cannot
 * both win: the second violates this index and is told so, which is exactly
 * the signal to go and look at what the first one did.
 */
CREATE UNIQUE INDEX import_files_committed_destination_idx
  ON import_files (destination_key)
  WHERE state = 'committed' AND destination_key IS NOT NULL;

-- Every state change, in order. Append-only.
CREATE TABLE import_events (
  id bigserial PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  -- Null for events about the import as a whole.
  import_file_id uuid REFERENCES import_files(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  failure_class text,
  detail text,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_events_import_idx ON import_events (import_id, id);

COMMENT ON COLUMN imports.source_root IS
  'The download root this import was authorised against at plan time. '
  'Containment is re-proven against this, never against current configuration.';

COMMENT ON COLUMN imports.library_root IS
  'The library root this import was authorised against at plan time.';

COMMENT ON COLUMN imports.idempotency_key IS
  'Names the staging artifacts on disk, so a restarted process can recognise '
  'its own half-finished work rather than starting a second copy beside it.';

COMMENT ON COLUMN imports.committed_at IS
  'When the destination became durable. Cleanup runs after this and cannot '
  'un-commit the import, so a cleanup failure never invalidates a good import.';

COMMENT ON COLUMN import_files.destination_key IS
  'Normalised, case-folded destination path. Case-folded because the library '
  'lives on a case-insensitive filesystem, where two names differing only in '
  'case are one file.';

COMMENT ON INDEX import_files_committed_destination_idx IS
  'One committed file per destination, across all imports. Makes duplicate '
  'library objects impossible rather than merely unlikely.';
