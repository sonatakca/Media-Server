-- What a backup actually proved, kept so "successful" can mean something.
--
-- The Phase-1 scripts already take the backup; what they have never had is a
-- durable record of what each run produced. Without one, a panel reporting a
-- backup as healthy is reporting that a script exited zero at some point,
-- which is exactly the kind of check that reads as passing while checking
-- nothing — the same defect the restore-verification query had for years.
--
-- So every column here is evidence rather than intent: what was found, what
-- was verified, and what the schema was at the time.

CREATE TABLE backup_runs (
  id uuid PRIMARY KEY,

  -- planned | running | succeeded | failed. A run that never reported an
  -- ending is distinguishable from one that ended badly.
  state text NOT NULL,

  /*
   * Where it went, as a class rather than a path.
   *
   * `local-protected` is the protected directory on the system volume;
   * `removable` and `remote` exist so a later destination can be recorded
   * without this column ever holding somebody's directory layout.
   */
  destination_class text NOT NULL,

  -- What was present when the run finished. Three separate facts because a
  -- dump without its configuration is a different kind of incomplete from
  -- configuration without its dump.
  dump_present boolean NOT NULL DEFAULT false,
  config_present boolean NOT NULL DEFAULT false,
  secrets_present boolean NOT NULL DEFAULT false,
  dump_bytes bigint,

  /*
   * The schema the dump carries, read from `seyirlik_migrations`.
   *
   * A backup is only restorable against code that understands its schema, so
   * the version is part of the evidence rather than a nicety.
   */
  schema_version text,
  schema_count integer,

  /*
   * Whether a restore was actually rehearsed, and what it showed.
   *
   * `verified` means a restore into a scratch database succeeded and its table
   * count matched the live one. Anything else is `unverified`: a dump nobody
   * has restored is a hope, not a backup.
   */
  verification text NOT NULL DEFAULT 'unverified',
  verified_tables integer,
  live_tables integer,

  failure_class text,
  failure_detail text,

  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- The panel asks for the newest run, and for the newest that was verified.
CREATE INDEX backup_runs_recent_idx ON backup_runs (started_at DESC);
CREATE INDEX backup_runs_verified_idx
  ON backup_runs (started_at DESC)
  WHERE verification = 'verified';

COMMENT ON TABLE backup_runs IS
  'Evidence of what each backup produced. Holds no password, no secret '
  'content, no credential-bearing command and no absolute path: a destination '
  'is recorded as a class, and what was found is recorded as booleans.';

COMMENT ON COLUMN backup_runs.verification IS
  'verified only when a restore into a scratch database succeeded and its '
  'table count matched the live database. A dump nobody has restored is a '
  'hope rather than a backup.';
