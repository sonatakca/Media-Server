import type { ProcessingJob } from "../../lib/processingApi";

/**
 * The queue tab's own logic, kept out of the component.
 *
 * Three questions live here: which half of the tab a job belongs in, what
 * order the waiting ones are actually in, and what a drag would leave behind.
 * All three are pure and none of them touch the network, which is what lets a
 * page polling once a second re-sort without the row under the operator's
 * cursor jumping somewhere else.
 */

/** The two halves of the Processes tab. */
export type ProcessingOutcomeTab = "active" | "finished";

export const PROCESSING_OUTCOME_TABS: readonly ProcessingOutcomeTab[] = [
  "active",
  "finished",
];

const CONCLUDED_STATES: ReadonlySet<ProcessingJob["state"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * True once nothing more will happen to this job on its own.
 *
 * A retry creates a fresh attempt on the same row, so this is a statement
 * about now rather than for ever — which is exactly what a tab labelled
 * "concluded" claims.
 */
export function isConcluded(job: Pick<ProcessingJob, "state">): boolean {
  return CONCLUDED_STATES.has(job.state);
}

/**
 * True while the job is doing the work rather than waiting for its turn.
 *
 * `running` alone is not enough: a job that has been asked to pause, or that
 * the storage guard is holding, still owns the encoder and its workspace. None
 * of them can be moved in the queue, and all of them belong at the top of it.
 */
function isUnderway(job: Pick<ProcessingJob, "state">): boolean {
  return job.state === "running" || job.state === "paused";
}

/**
 * Whether this row can be dragged.
 *
 * The server hands back a position only for a job that is genuinely still
 * waiting; a claimed attempt and a finished one both report `null`. Reading
 * the position rather than the state is deliberate — the state says what the
 * job is doing, and only the queue row knows whether moving it would still
 * mean anything by the time the request lands.
 */
export function canReorder(job: Pick<ProcessingJob, "queuePriority">): boolean {
  return typeof job.queuePriority === "number";
}

function byCreatedAtAscending(
  left: Pick<ProcessingJob, "createdAt">,
  right: Pick<ProcessingJob, "createdAt">,
): number {
  const difference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  // An unparseable timestamp yields NaN, and a NaN comparator scrambles the
  // list. Falling back to "equal" leaves the pair where the sort found them.
  return Number.isFinite(difference) ? difference : 0;
}

/**
 * The waiting line, in the order the machine will actually work through it.
 *
 * What is underway comes first — it is the one thing on this page that is
 * happening rather than pending — and the rest follow by the position the
 * queue holds for them. Jobs the server gave no position to sort last by age
 * rather than being dropped: a job whose attempt is missing is still work
 * somebody queued, and hiding it is how a stuck row goes unnoticed.
 */
export function orderQueue(jobs: readonly ProcessingJob[]): ProcessingJob[] {
  return [...jobs].sort((left, right) => {
    const leftUnderway = isUnderway(left);
    const rightUnderway = isUnderway(right);
    if (leftUnderway !== rightUnderway) return leftUnderway ? -1 : 1;
    if (leftUnderway) return byCreatedAtAscending(left, right);

    const leftPlace = left.queuePriority;
    const rightPlace = right.queuePriority;
    const leftPlaced = typeof leftPlace === "number";
    const rightPlaced = typeof rightPlace === "number";
    if (leftPlaced !== rightPlaced) return leftPlaced ? -1 : 1;
    if (leftPlaced && rightPlaced && leftPlace !== rightPlace) {
      return leftPlace - rightPlace;
    }
    return byCreatedAtAscending(left, right);
  });
}

/**
 * Finished jobs, newest first.
 *
 * The opposite of the queue on purpose: a waiting list reads forwards because
 * the top of it is what happens next, and a history reads backwards because
 * the top of it is what just happened. `finishedAt` can be missing on a row
 * whose worker vanished, so the creation time stands in rather than sinking it
 * to the bottom.
 */
export function orderHistory(jobs: readonly ProcessingJob[]): ProcessingJob[] {
  const endedAt = (job: ProcessingJob) =>
    Date.parse(job.finishedAt ?? job.createdAt);
  return [...jobs].sort((left, right) => endedAt(right) - endedAt(left));
}

/** The tab a job belongs in, and the order it is shown in there. */
export function partitionProcessingJobs(jobs: readonly ProcessingJob[]): {
  active: ProcessingJob[];
  finished: ProcessingJob[];
} {
  const active: ProcessingJob[] = [];
  const finished: ProcessingJob[] = [];
  for (const job of jobs) (isConcluded(job) ? finished : active).push(job);
  return { active: orderQueue(active), finished: orderHistory(finished) };
}

/**
 * The list after a row has been picked up and put down somewhere else.
 *
 * Returns the same array when nothing would change, so a drag that ends where
 * it started cannot start a request. Out-of-range indices are clamped rather
 * than rejected: a drop onto the empty space past the last row means "last",
 * which is what the pointer was over.
 */
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  if (from < 0 || from >= items.length) return [...items];
  const target = Math.min(Math.max(to, 0), items.length - 1);
  if (target === from) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * The queue as the operator last left it, on top of what the server last said.
 *
 * A drag is answered by a request and a refresh, and the page polls in between;
 * without this, a poll landing in that gap would snap the row back to where it
 * was dragged from and then forward again a second later. Rows the override
 * does not name keep the slot the server gave them, so a job queued during the
 * drag, and the encode that is running, both stay where they belong.
 */
export function applyQueueOverride(
  ordered: readonly ProcessingJob[],
  override: readonly string[] | null,
): ProcessingJob[] {
  if (!override || override.length === 0) return [...ordered];
  const named = new Set(override);
  const byId = new Map(ordered.map((job) => [job.id, job]));
  /*
   * The override rearranges the rows it names *within the slots those rows
   * already occupy*. Sorting the whole list by it instead would sink every row
   * it does not mention — the encode that is running, above all — to the
   * bottom, which is the one position it can never be in.
   */
  const moved = override
    .map((id) => byId.get(id))
    .filter((job): job is ProcessingJob => job !== undefined);
  let taken = 0;
  return ordered.map((job) =>
    named.has(job.id) ? (moved[taken++] ?? job) : job,
  );
}
