-- Storage faults that outlive the process that saw them.
--
-- Every circuit breaker in this system lived in memory, which meant a reboot
-- was a reset. That is exactly backwards for the failure it has to survive: a
-- USB-attached drive returning EIO from the SCSI layer put the machine into a
-- kernel retry storm severe enough to require a forced power-off, and the
-- forced power-off is what cleared the only record that anything was wrong.
-- Within seconds of the next login the worker found a job still marked
-- `running`, saw that the media root answered a `stat`, and sent FFmpeg back at
-- the same region.
--
-- So the quarantine is a row. It is written when the fault is established, it
-- is read before any work starts, and nothing but an operator's explicit
-- recovery clears it — not a restart, not a remount, not a poll that finds the
-- directory listable, which is precisely what a failing drive looks like
-- between retry storms.

CREATE TABLE storage_incidents (
  id uuid PRIMARY KEY,
  -- The configured root this is about. Not a device number: those are assigned
  -- at mount time and change across reboots, so a device-keyed quarantine would
  -- clear itself on the one event it most needs to survive.
  storage_root varchar(512) NOT NULL,
  -- Mirrors StorageHealthState in src/renditions/processing/storageHealth.ts.
  -- 'healthy' rows are kept rather than deleted so that a cleared incident
  -- remains in the history: "this drive was quarantined in March and released"
  -- is worth more than the absence of a row.
  state text NOT NULL,
  reason varchar(500) NOT NULL,
  -- What kind of evidence established it, for an operator deciding whether to
  -- suspect the disk, the bridge, the cable or the port.
  failure_class varchar(64),
  fault_count integer NOT NULL DEFAULT 0,
  first_fault_at timestamptz,
  last_fault_at timestamptz,
  -- The job that was running when the fault landed, if there was one. Nulled
  -- rather than cascaded on delete: losing the job history must not lose the
  -- record that the storage misbehaved.
  processing_job_id uuid REFERENCES processing_jobs (id) ON DELETE SET NULL,
  quarantined_at timestamptz,
  -- Set by the cheap non-destructive check an operator runs from the page. It
  -- reads directory metadata and a device identity and nothing else: verifying
  -- a suspect drive must never mean reading a suspect drive.
  verified_at timestamptz,
  -- Set by the operator's second, explicit press. Two steps on purpose, so that
  -- reconnecting a drive is never on its own the thing that restarts an encode.
  cleared_at timestamptz,
  acknowledged_by uuid REFERENCES native_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT storage_incidents_state_known CHECK (
    state IN ('healthy', 'unavailable', 'suspect', 'quarantined', 'recovery-pending')
  ),
  CONSTRAINT storage_incidents_fault_count_nonnegative CHECK (fault_count >= 0)
);

-- One open incident per root. The gate reads this on every decision to start
-- work, so it has to be a single unambiguous row rather than a scan of history.
CREATE UNIQUE INDEX storage_incidents_open_root_idx
  ON storage_incidents (storage_root)
  WHERE cleared_at IS NULL;

CREATE INDEX storage_incidents_recent_idx
  ON storage_incidents (created_at DESC);

-- Two further pause reasons, so a job stopped by a quarantine cannot be
-- mistaken for one stopped by an ordinary unmount.
--
-- The distinction is the whole safety property: `storage-unavailable` is what
-- `requeueStorageInterruptedJobs` looks for and automatically restarts, and a
-- job whose storage is quarantined must never appear in that list.
ALTER TABLE processing_jobs
  DROP CONSTRAINT processing_jobs_paused_reason_known;

ALTER TABLE processing_jobs
  ADD CONSTRAINT processing_jobs_paused_reason_known
  CHECK (paused_reason IS NULL OR paused_reason IN (
    'operator',
    'storage-unavailable',
    -- The storage this job needs has an established fault. No automatic resume.
    'storage-quarantined',
    -- The last attempt ended without anyone observing how. Held until the
    -- recovery policy, or a person, decides it is safe to run again.
    'recovery-pending'
  ));

COMMENT ON COLUMN processing_jobs.paused_reason IS
  'Why the job is paused. Only ''storage-unavailable'' is automatically resumable; ''storage-quarantined'' and ''recovery-pending'' require an operator.';

-- Existing rows are left exactly as they are. A job paused as
-- 'storage-unavailable' before this migration keeps that reason and keeps its
-- automatic recovery, because at the time it was recorded that is genuinely
-- what was observed. Reclassifying history from here would be inventing
-- evidence, and the one thing worse than an over-eager resume is a quarantine
-- nobody can account for.
