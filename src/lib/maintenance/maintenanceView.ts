import {
  isConcluded,
  lifecycleOf,
  newerProgress,
  type MaintenanceLifecycle,
  type MaintenanceTaskDto,
} from "./maintenanceTasks";

/**
 * The Library Scan task viewer's own logic, kept out of the component.
 *
 * Four questions live here: which half of the viewer a task belongs in, what
 * order the waiting ones are in, what a drag would leave behind, and which of
 * two snapshots of the same task is the newer. All four are pure, so a page
 * polling every couple of seconds can re-sort without the row under the
 * operator's cursor jumping somewhere else, and every one of them can be
 * asserted without a browser.
 */

/**
 * The two modes of the Library Maintenance page.
 *
 * Held in the query string rather than in component state, so the back button,
 * a reload and a pasted link all land where the operator expects. The
 * operational tab writes no parameter at all, which keeps the plain URL plain.
 */
export const MAINTENANCE_TABS = ["scan", "metadata"] as const;
export type MaintenanceTab = (typeof MAINTENANCE_TABS)[number];

/** The tab the URL names, or the operational one, which is the default. */
export function tabFromSearch(value: string | null): MaintenanceTab {
  return MAINTENANCE_TABS.find((tab) => tab === value) ?? "scan";
}

/** The two halves of the Tasks panel. */
export type MaintenanceOutcomeTab = "active" | "concluded";

export const MAINTENANCE_OUTCOME_TABS: readonly MaintenanceOutcomeTab[] = [
  "active",
  "concluded",
];

/**
 * Which half a task belongs in, decided by the server's own status and
 * nothing else.
 *
 * A failed attempt that the queue will try again is `queued`, not `failed`, so
 * it stays in the running half where it belongs — the row is going to run
 * again and a history that already claimed it was over would be wrong within
 * the minute.
 */
export function partitionMaintenanceTasks(
  tasks: readonly MaintenanceTaskDto[],
): {
  active: MaintenanceTaskDto[];
  concluded: MaintenanceTaskDto[];
} {
  const active: MaintenanceTaskDto[] = [];
  const concluded: MaintenanceTaskDto[] = [];
  for (const task of tasks) {
    (isConcluded(task) ? concluded : active).push(task);
  }
  return { active, concluded };
}

/**
 * True when the server would accept a reorder for this row.
 *
 * Read from the field the server sets rather than re-derived from the status:
 * legality is the server's decision, and a client that worked it out for
 * itself would be a second implementation of the rule, free to disagree.
 */
export function canReorderTask(
  task: Pick<MaintenanceTaskDto, "reorderable">,
): boolean {
  return task.reorderable;
}

/**
 * The line as the operator last left it, on top of what the server last said.
 *
 * A drag is answered by a request and a refresh, and the page polls in
 * between; without this a poll landing in that gap would snap the row back to
 * where it was dragged from and then forward again a moment later.
 *
 * The override rearranges the rows it names *within the slots those rows
 * already occupy*. Sorting the whole list by it would sink every row it does
 * not mention — the scan that is running, above all — to the bottom, which is
 * the one position it can never be in.
 */
export function applyOrderOverride<T extends { id: string }>(
  ordered: readonly T[],
  override: readonly string[] | null,
): T[] {
  if (!override || override.length === 0) return [...ordered];
  const named = new Set(override);
  const byId = new Map(ordered.map((item) => [item.id, item]));
  const moved = override
    .map((id) => byId.get(id))
    .filter((item): item is T => item !== undefined);
  let taken = 0;
  return ordered.map((item) =>
    named.has(item.id) ? (moved[taken++] ?? item) : item,
  );
}

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
 * Moves a whole selected block to one end of the queue, keeping its order.
 *
 * Written as "take them out, put them back" rather than as a series of
 * single-step moves: a group crossing the list one place at a time passes
 * through orders nobody asked for, and one of them would be committed if a
 * refusal landed halfway.
 */
export function moveBlock(
  ids: readonly string[],
  block: readonly string[],
  edge: "front" | "back",
): string[] {
  const carried = new Set(block);
  const kept = ids.filter((id) => !carried.has(id));
  const moving = ids.filter((id) => carried.has(id));
  if (moving.length === 0) return [...ids];
  return edge === "front" ? [...moving, ...kept] : [...kept, ...moving];
}

/**
 * Merges an arriving snapshot onto the one the page is holding.
 *
 * The snapshot is the whole truth — it is one read of the queue — so it
 * replaces what was held. The one thing carried across is a progress record
 * whose revision is higher than the arriving one's, which is how a page that
 * has seen revision 40 keeps it when a slow response hands back 31. Without
 * that guard a counter can walk backwards, and a counter that walks backwards
 * is worse than no counter at all.
 *
 * Only the same attempt of the same task is merged: a new attempt clears the
 * stored snapshot server-side, and revisions restart from one.
 */
export function mergeSnapshot(
  held: readonly MaintenanceTaskDto[],
  arriving: readonly MaintenanceTaskDto[],
): MaintenanceTaskDto[] {
  if (held.length === 0) return [...arriving];
  const heldById = new Map(held.map((task) => [task.id, task]));
  return arriving.map((task) => {
    const previous = heldById.get(task.id);
    if (
      !previous ||
      previous.status !== task.status ||
      previous.attempts !== task.attempts
    ) {
      return task;
    }
    const progress = newerProgress(previous.progress, task.progress);
    return progress === task.progress
      ? task
      : { ...task, progress, progressAt: progress?.at ?? task.progressAt };
  });
}

/**
 * How long the task has been running, in seconds, or null when it has not.
 *
 * A queued row is not accumulating anything, and a clock running beside one is
 * an invitation to believe a worker is stuck rather than that nothing has
 * started.
 */
export function elapsedSeconds(
  task: Pick<MaintenanceTaskDto, "startedAt" | "finishedAt">,
  nowMs: number,
): number | null {
  if (!task.startedAt) return null;
  const start = Date.parse(task.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = task.finishedAt ? Date.parse(task.finishedAt) : nowMs;
  if (!Number.isFinite(end) || end < start) return null;
  return (end - start) / 1000;
}

/** How long the task waited before a worker claimed it, in seconds. */
export function queueWaitSeconds(
  task: Pick<MaintenanceTaskDto, "queuedAt" | "startedAt">,
  nowMs: number,
): number | null {
  const queued = Date.parse(task.queuedAt);
  if (!Number.isFinite(queued)) return null;
  const claimed = task.startedAt ? Date.parse(task.startedAt) : nowMs;
  if (!Number.isFinite(claimed) || claimed < queued) return null;
  return (claimed - queued) / 1000;
}

/**
 * Seconds since the executor last said anything, for a running task.
 *
 * The one number that distinguishes a long job from a wedged one, and the
 * reason `progressAt` is carried separately from `startedAt`.
 */
export function sinceProgressSeconds(
  task: Pick<MaintenanceTaskDto, "progressAt">,
  nowMs: number,
): number | null {
  if (!task.progressAt) return null;
  const at = Date.parse(task.progressAt);
  if (!Number.isFinite(at) || nowMs < at) return null;
  return (nowMs - at) / 1000;
}

/**
 * The tasks of one "All in one" run, in the order they happened.
 *
 * Grouping is by the id the run carries in its payload; a task without one is
 * its own work and is never folded into somebody else's run.
 */
export function runSiblings(
  tasks: readonly MaintenanceTaskDto[],
  runId: string | undefined,
): MaintenanceTaskDto[] {
  if (!runId) return [];
  return tasks
    .filter((task) => task.runId === runId)
    .sort(
      (left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt),
    );
}

export type { MaintenanceLifecycle };
export { lifecycleOf, isConcluded };
