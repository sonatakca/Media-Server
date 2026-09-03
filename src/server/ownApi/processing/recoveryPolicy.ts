import type { StorageHealthState } from "../../../renditions/processing/storageHealth";
import {
  requiresOperatorAfterUncleanRestart,
  type VolumeIdentity,
} from "../../../renditions/processing/storageIdentity";

/**
 * What to do with work the last run left behind.
 *
 * The old rule was one line and it is worth writing out, because everything
 * here exists to replace it:
 *
 *   const storageReady = await storageWatchdog.poll();
 *   if (storageReady) await requeueStorageInterruptedJobs();
 *
 * "The path is listable, therefore resume." Applied to a job left `running` by
 * a forced power-off, against a drive whose USB bridge was returning `EIO`
 * while its cached directory metadata answered instantly. It resumed. FFmpeg
 * went back at the same region, the kernel re-entered its retry sequence, and
 * the machine had to be powered off a second time.
 *
 * The replacement separates three things the old rule conflated: whether the
 * storage answers, whether anything is *known* about how the last attempt
 * ended, and whether a person has said it is safe. Pure and total, so the
 * policy can be enumerated in a test rather than inferred from a running
 * system — which for this failure is the only way it can be tested at all.
 */

export type JobRecoveryDecision =
  /** Requeue now. The storage is trusted and the interruption was accounted for. */
  | { action: "resume"; reason: string }
  /**
   * Keep the job alive, paused, and pick it up when the volume returns and
   * settles. The clean-unmount path, unchanged in spirit from what worked.
   */
  | { action: "await-storage"; reason: string }
  /**
   * Keep the job alive, paused, and do not touch it until a person says so.
   * Nothing here is broken; nothing here is understood either.
   */
  | { action: "await-operator"; reason: string };

export interface JobRecoveryInput {
  /** The guard's verdict for the root this job's source lives on. */
  storageState: StorageHealthState;
  /**
   * Whether the interruption was observed at the time.
   *
   * True for a job the runner itself parked — it saw the volume go, wrote the
   * reason, and stopped the encoder. False for a job found still marked
   * `running`, which means the process that owned it died without a word and
   * nothing knows whether it was reading a bad sector at the time.
   */
  interruptionWasObserved: boolean;
  /**
   * Whether this job's own history records a storage fault on this attempt.
   *
   * Distinct from the storage's state: a root can be healthy overall while this
   * particular job died to an I/O error a moment before the fault was
   * established. Resuming it would be the one job guaranteed to go straight
   * back at the sectors that failed.
   */
  jobSawStorageFault: boolean;
  /**
   * Whether the source lives on storage that can disappear.
   *
   * An internal volume that "went away" did not go away; something else is
   * wrong, and the automatic wait-and-resume built for a USB drive is not the
   * right answer for it. Callers that cannot tell should pass `true`, which is
   * the cautious direction.
   */
  externallyBacked: boolean;
}

export function decideJobRecovery({
  storageState,
  interruptionWasObserved,
  jobSawStorageFault,
  externallyBacked,
}: JobRecoveryInput): JobRecoveryDecision {
  /*
   * The storage's own verdict outranks everything about the job. A quarantine
   * exists precisely to stop work no matter how healthy that work looks, and a
   * job that reads a different file on the same failing platter is not a
   * special case.
   */
  if (storageState === "quarantined") {
    return {
      action: "await-operator",
      reason:
        "The storage this job needs is quarantined after an I/O failure. It will not resume until an operator verifies and resumes it.",
    };
  }
  if (storageState === "suspect") {
    return {
      action: "await-operator",
      reason:
        "The storage this job needs reported an I/O failure and is being held. It will not resume on its own.",
    };
  }
  /*
   * A job that died to an I/O error is held even where the volume as a whole
   * has not yet earned a quarantine. One fault is not enough to condemn a
   * drive; it is more than enough to stop sending the same encoder back at the
   * same bytes, which is the cheapest possible way to collect the second fault.
   */
  if (jobSawStorageFault) {
    return {
      action: "await-operator",
      reason:
        "The previous attempt failed with a storage I/O error. Another attempt would read the same region, so it waits for an operator.",
    };
  }

  /*
   * The case this whole file was written for, and checked before the generic
   * `recovery-pending` branch below rather than after it — because the two
   * arrive at the same *state* by different routes and only one of them may
   * claim a verification happened.
   *
   * Nothing is known to be wrong here, and nothing is known at all, which on an
   * external volume is not a state in which to start a multi-hour encode
   * unattended. It costs an operator one press, and it is the press that would
   * have prevented the second forced power-off.
   */
  if (!interruptionWasObserved && externallyBacked) {
    return {
      action: "await-operator",
      reason:
        "The job was found still marked running after an unclean shutdown, on external storage. Nothing observed how the last attempt ended, so it waits for an operator rather than starting again on its own.",
    };
  }

  if (storageState === "recovery-pending") {
    return {
      action: "await-operator",
      reason:
        "The storage is held for an operator to review and resume. Nothing runs here until they do.",
    };
  }

  if (storageState === "unavailable") {
    return {
      action: "await-storage",
      reason:
        "The storage is not available. The job keeps its checkpoints and continues once the same volume returns and stays.",
    };
  }

  /*
   * Storage healthy, job clean, and the interruption was written down at the
   * time. The remaining case is an internal volume, where "it went away" did
   * not happen and there is nothing to wait for.
   */
  if (interruptionWasObserved) {
    return {
      action: "resume",
      reason:
        "The interruption was recorded at the time and the storage is healthy.",
    };
  }

  return {
    action: "resume",
    reason:
      "The job was interrupted on internal storage that is healthy, so a fresh attempt starts.",
  };
}

/**
 * Whether losing this storage is the kind of event a person should confirm
 * before a multi-hour encode restarts unattended.
 *
 * Delegates to the identity module so there is one rule rather than two that
 * can drift. The path test that used to live here is still in there, but only
 * as the fallback for a volume nothing could identify — because on its own it
 * was wrong in both directions: it held up the E2E suite for a disk image
 * mounted under `/Volumes`, and it would have waved through a failing external
 * drive mounted anywhere else.
 */
export function requiresOperatorRecovery(
  identity: VolumeIdentity | null,
  root: string,
): boolean {
  return requiresOperatorAfterUncleanRestart(identity, root);
}

/**
 * The path-only test, kept for callers that have no identity to offer.
 *
 * Prefer `requiresOperatorRecovery`. This exists because a mount path is
 * sometimes genuinely all a caller has, and answering cautiously from it beats
 * answering nothing.
 */
export function looksExternallyBacked(root: string): boolean {
  return requiresOperatorAfterUncleanRestart(null, root);
}

/** Error codes on a job row that mean its last attempt met a storage fault. */
const STORAGE_FAULT_CODES: ReadonlySet<string> = new Set([
  "SOURCE_UNREADABLE",
  "INSUFFICIENT_DISK_SPACE",
]);

/**
 * Whether a job's own record says its last attempt met a storage fault.
 *
 * `MEDIA_PROGRESS_TIMEOUT` is deliberately absent. That code means the encoder
 * stopped while the source read perfectly, which is a fault in the encode and
 * says nothing about the disk — the distinction cost a real investigation to
 * establish and must not be quietly undone by a set membership test.
 */
export function jobRecordsStorageFault(job: {
  errorCode: string | null;
  pausedReason: string | null;
}): boolean {
  if (job.pausedReason === "storage-quarantined") return true;
  return job.errorCode !== null && STORAGE_FAULT_CODES.has(job.errorCode);
}
