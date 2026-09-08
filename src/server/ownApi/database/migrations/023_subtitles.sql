-- Subtitles Seyirlik is responsible for: what somebody wants, what was tried,
-- and what this system put on the disk.
--
-- Three tables rather than one, because they answer three questions with three
-- different lifetimes. A *want* outlives every attempt to satisfy it. An
-- *attempt* is a bounded piece of work with a state machine. An *installed*
-- subtitle is a fact about the filesystem that has to survive the row that
-- caused it being cleaned up, because it is the only thing that establishes
-- whether this system may overwrite a file later.

/*
 * What somebody wants for one video file.
 *
 * Keyed on the media file rather than the item: a film kept as a theatrical and
 * a director's cut is one item and two files, and a translation timed to one is
 * wrong against the other.
 *
 * `forced` is part of the key because a forced subtitle is a different want,
 * never a lesser version of a full one. The hearing-impaired *preference* is
 * not: it ranks candidates and does not decide whether the want is answered, so
 * two rows differing only in it would be the same want twice.
 */
CREATE TABLE subtitle_wants (
  id uuid PRIMARY KEY,
  media_file_id uuid NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  language varchar(16) NOT NULL,
  forced boolean NOT NULL DEFAULT false,
  -- prefer | avoid | indifferent
  hearing_impaired text NOT NULL DEFAULT 'indifferent',

  /*
   * Whether this system should still be looking.
   *
   * Set false when the want is answered, or when an operator says to stop
   * asking. Kept as a column rather than inferred from the presence of an
   * installed subtitle, because "somebody added one by hand and we should stop
   * searching" and "we installed one" are different facts.
   */
  active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subtitle_wants_language_shape
    CHECK (language ~ '^[a-z]{2,3}$'),
  CONSTRAINT subtitle_wants_hearing_impaired_known
    CHECK (hearing_impaired IN ('prefer', 'avoid', 'indifferent'))
);

CREATE UNIQUE INDEX subtitle_wants_unique
  ON subtitle_wants (media_file_id, language, forced);
CREATE INDEX subtitle_wants_active_idx
  ON subtitle_wants (active) WHERE active;

/*
 * One attempt to satisfy one want.
 *
 * The state column carries the same names the domain uses, and the two states a
 * crash can land in — downloading and validating — are the ones a reconcile
 * pass has to look at the disk for. `attempt` counts only real tries: a pause
 * waiting for somebody to authenticate is not an attempt, and counting it would
 * spend the retry budget on a person's response time.
 */
CREATE TABLE subtitle_attempts (
  id uuid PRIMARY KEY,
  want_id uuid NOT NULL REFERENCES subtitle_wants(id) ON DELETE CASCADE,

  state text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,

  /*
   * The provider and candidate this attempt settled on, once it has. Opaque
   * here: `candidate_id` means nothing except to the provider that issued it,
   * and nothing in this schema parses it.
   */
  provider_id varchar(64),
  candidate_id varchar(256),
  score integer,
  /* Why this candidate, in the words the scorer produced. Operator-facing. */
  score_reasons jsonb,

  failure_class text,
  /*
   * Safe for an operator and a log. A provider's own response body never
   * reaches this column: it is untrusted text, and it is exactly where a
   * session cookie would end up if anybody let it.
   */
  failure_detail text,

  /* Set while the attempt is waiting for somebody to establish a session. */
  awaiting_provider_id varchar(64),

  run_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subtitle_attempts_state_known CHECK (state IN (
    'wanted', 'searching', 'selected', 'downloading', 'validating',
    'installed', 'needs-authentication', 'unavailable', 'failed', 'superseded'
  )),
  CONSTRAINT subtitle_attempts_attempt_non_negative CHECK (attempt >= 0),
  /* A paused attempt must say who it is waiting for; nothing else may. */
  CONSTRAINT subtitle_attempts_awaiting_matches_state CHECK (
    (state = 'needs-authentication') = (awaiting_provider_id IS NOT NULL)
  )
);

CREATE INDEX subtitle_attempts_want_idx ON subtitle_attempts (want_id);
/* The reconcile pass's query: everything a crash could have left mid-write. */
CREATE INDEX subtitle_attempts_uncertain_idx ON subtitle_attempts (state)
  WHERE state IN ('downloading', 'validating');
/* The scheduler's query. */
CREATE INDEX subtitle_attempts_runnable_idx ON subtitle_attempts (run_after)
  WHERE state IN ('wanted', 'searching', 'selected');

/*
 * A subtitle this system installed.
 *
 * The reason this table exists, and the reason it is not merely a column on the
 * attempt, is ownership. A subtitle file has nowhere to put a marker — unlike an
 * NFO, which carries one in its text — so the only way to know whether Seyirlik
 * wrote the file at a given path is to have recorded that it did, along with
 * the digest of what it wrote. Ownership decides whether a later upgrade may
 * overwrite the file, and getting it wrong destroys somebody's hand-made
 * translation.
 *
 * The digest is of the bytes as installed. A file whose digest no longer
 * matches has been edited by somebody else since, and is no longer ours to
 * replace.
 */
CREATE TABLE subtitle_installations (
  id uuid PRIMARY KEY,
  media_file_id uuid NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  want_id uuid REFERENCES subtitle_wants(id) ON DELETE SET NULL,
  attempt_id uuid REFERENCES subtitle_attempts(id) ON DELETE SET NULL,

  /* Library-relative POSIX, the same form the catalogue stores. */
  relative_path text NOT NULL,
  language varchar(16) NOT NULL,
  forced boolean NOT NULL DEFAULT false,
  hearing_impaired boolean NOT NULL DEFAULT false,
  format varchar(8) NOT NULL,

  sha256 char(64) NOT NULL,
  size_bytes bigint NOT NULL,
  cue_count integer,

  provider_id varchar(64),
  /* unknown | assumed-in-sync | reported-out-of-sync */
  sync_state text NOT NULL DEFAULT 'unknown',

  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subtitle_installations_format_known
    CHECK (format IN ('srt', 'vtt')),
  CONSTRAINT subtitle_installations_sync_known
    CHECK (sync_state IN ('unknown', 'assumed-in-sync', 'reported-out-of-sync')),
  CONSTRAINT subtitle_installations_size_non_negative CHECK (size_bytes >= 0)
);

/*
 * One record per path. The ownership question is asked as "did we write the
 * file at this path", so two rows for one path would make it unanswerable.
 */
CREATE UNIQUE INDEX subtitle_installations_path_unique
  ON subtitle_installations (media_file_id, relative_path);
CREATE INDEX subtitle_installations_media_idx
  ON subtitle_installations (media_file_id);
