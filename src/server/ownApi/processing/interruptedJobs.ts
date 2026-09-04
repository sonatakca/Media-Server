import {
  decideJobRecovery,
  jobRecordsStorageFault,
  requiresOperatorRecovery,
  type JobRecoveryDecision,
} from "./recoveryPolicy";
import type { VolumeIdentity } from "../../../renditions/processing/storageIdentity";
import type { StorageGuard } from "./storageGuard";
import type {
  ProcessingJobRecord,
  ProcessingJobStore,
  ProcessingPauseReason,
} from "./jobStore";

/**
 * What to do, at startup, with jobs the last run left marked `running`.
 *
 * Nothing can still be encoding at the moment a process starts, so such a row
 * is the residue of a worker that died or a machine that was powered off. The
 * rule that used to handle it was one line —
 *
 *   if (await storageWatchdog.poll()) await requeueStorageInterruptedJobs();
 *
 * — and on the day of the incident that poll returned `true`, for a drive whose
 * USB bridge was returning `EIO` from the block layer while its cached
 * directory metadata answered instantly. The job was requeued within seconds of
 * login, FFmpeg went back at the same region, and the machine had to be powered
 * off a second time.
 *
 * It lives here rather than inside the runtime's constructor for one reason:
 * this is the most safety-critical decision in the system and it was, until
 * now, reachable only by starting a real server against a real volume. It takes
 * a store and a guard, both of which a test can supply.
 */

export interface ReconcileInterruptedJobsInput {
  store: Pick<
    ProcessingJobStore,
    "findInterrupted" | "requestPause" | "appendEvent" | "finalizeCancelled"
  >;
  guard: StorageGuard;
  /** The media root, used only to decide whether it can be unplugged. */
  mediaRoot: string;
  /** The watchdog's availability answer, taken once for the whole pass. */
  storageAvailable: () => Promise<boolean>;
  /** Requeues the jobs that were found safe. Injected so a test can count it. */
  requeue: () => Promise<number>;
  /**
   * What the media root actually is, when it can be established.
   *
   * Decides whether an unclean restart needs a person. Absent — no probe on this
   * platform, or the volume is not mounted — falls back to the path heuristic,
   * which is the cautious direction.
   */
  identity?: VolumeIdentity | null;
}

export interface InterruptedJobOutcome {
  jobId: string;
  decision: JobRecoveryDecision;
  pausedAs: ProcessingPauseReason;
}

export interface ReconcileInterruptedJobsResult {
  outcomes: InterruptedJobOutcome[];
  /** How many jobs were actually put back on the queue. */
  requeued: number;
  /**
   * Jobs ended here because a cancellation had been asked for and the process
   * that would have carried it out no longer exists.
   */
  cancelled: string[];
}

/**
 * The one pause reason an automatic path may act on.
 *
 * `storage-unavailable` means a volume went away cleanly and is expected back.
 * A poll, a watchdog tick, a restart or a remount may undo that pause and
 * nothing else, which is why the automatic requeue queries this reason alone
 * rather than filtering a wider result.
 */
export const AUTOMATIC_REQUEUE_PAUSE_REASON = "storage-unavailable" as const;

/**
 * The reasons only a person may lift.
 *
 * Deliberately invisible to the automatic requeue's query. Guarding them with a
 * runtime check as well would be safe, but it would be one mistake deep: a
 * single wrong edit to that check and a quarantine becomes automatically
 * resumable. Keeping them out of the query means two independent mechanisms
 * have to fail before a held job runs.
 */
export const OPERATOR_HELD_PAUSE_REASONS = [
  "recovery-pending",
  "storage-quarantined",
] as const satisfies readonly ProcessingPauseReason[];

/**
 * The pause reason a decision translates into.
 *
 * Kept apart from the decision itself because the two vocabularies answer
 * different questions: the decision says *who* may restart this, and the reason
 * says what a later reader — including `requeueStorageInterruptedJobs`, which
 * queries this column — will conclude. Only `storage-unavailable` appears in
 * that query, so this mapping is what actually enforces the policy.
 */
export function pauseReasonFor(
  decision: JobRecoveryDecision,
  storageState: StorageGuard["health"]["state"],
): ProcessingPauseReason {
  if (decision.action !== "await-operator") return "storage-unavailable";
  return storageState === "quarantined" || storageState === "suspect"
    ? "storage-quarantined"
    : "recovery-pending";
}

export async function reconcileInterruptedJobs({
  store,
  guard,
  mediaRoot,
  storageAvailable,
  requeue,
  identity = null,
}: ReconcileInterruptedJobsInput): Promise<ReconcileInterruptedJobsResult> {
  const interrupted: ProcessingJobRecord[] = await store.findInterrupted();
  if (interrupted.length === 0)
    return { outcomes: [], requeued: 0, cancelled: [] };

  await guard.observeAvailability(await storageAvailable());
  const externallyBacked = requiresOperatorRecovery(identity, mediaRoot);
  const outcomes: InterruptedJobOutcome[] = [];
  const cancelled: string[] = [];

  for (const job of interrupted) {
    /*
     * Somebody asked for this to stop, and the process that would have heard
     * them is gone. Pausing it instead is what left one of these rows marked
     * running for ever: `requestPause` refuses a job with a cancellation
     * pending — rightly, since pausing something on its way out is
     * meaningless — so the reconciliation quietly did nothing and the job
     * survived every restart. Nothing can be encoding at this moment, so the
     * cancellation is simply completed. No file is touched: a package, a
     * staging directory and a scratch workspace are released by the paths that
     * own them, and the scratch sweep below runs against the state this sets.
     */
    if (job.cancellationRequested) {
      const ended = await store.finalizeCancelled(job.id);
      if (ended) {
        await store.appendEvent({
          processingJobId: job.id,
          stage: "waiting",
          level: "warning",
          message:
            "Found still marked as running after a restart, with a cancellation pending. Nothing was executing it, so the cancellation was completed. Any published package is untouched.",
        });
        cancelled.push(job.id);
      }
      continue;
    }

    /*
     * An unclean restart with an encode in flight is recorded against the
     * storage as well as against the job. It is not evidence of a bad disk — a
     * power cut is not a bad sector — but it is evidence that nothing watched
     * the last attempt end, and on external storage that is enough to stop the
     * next one starting unattended.
     */
    if (externallyBacked) {
      await guard.reportUncleanRestart({
        detail:
          "A processing job was still marked running when this process started.",
        processingJobId: job.id,
      });
    }

    const decision = decideJobRecovery({
      storageState: guard.health.state,
      // Found still `running`: by definition nobody wrote down how it ended.
      interruptionWasObserved: false,
      jobSawStorageFault: jobRecordsStorageFault(job),
      externallyBacked,
    });
    const pausedAs = pauseReasonFor(decision, guard.health.state);

    await store.requestPause(job.id, pausedAs);
    await store.appendEvent({
      processingJobId: job.id,
      stage: "waiting",
      level: decision.action === "resume" ? "info" : "warning",
      /*
       * The old text was "starting a fresh attempt", written before anything
       * had decided whether that was safe. What it says now is the decision
       * itself, so the history records the reasoning rather than an intention.
       */
      message: `Found still marked as running after a restart. ${decision.reason}`,
      detail: { storageState: guard.health.state },
    });
    outcomes.push({ jobId: job.id, decision, pausedAs });
  }

  /*
   * Only jobs parked as `storage-unavailable` are eligible, and the requeue
   * re-checks the guard for itself. A job parked as `recovery-pending` or
   * `storage-quarantined` is not in the list that query reads, so it cannot be
   * swept up by a later storage-returned event either.
   */
  const requeued = guard.mayStartWork() ? await requeue() : 0;
  return { outcomes, requeued, cancelled };
}
