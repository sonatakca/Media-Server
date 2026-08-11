import type { TaskDto } from "../../api/ownApi/dto";
import type { TranslationKey } from "../../i18n/translations";

/**
 * Turning background jobs into notifications.
 *
 * The server already reports progress and outcome for every queued job; nothing
 * was reading it, so a library scan ran completely silently. This decides what
 * a poll of the task list should say, and is kept pure so the decisions can be
 * tested without a timer or a network.
 */

export type TaskNotificationTone = "info" | "success" | "error" | "progress";

export interface TaskNotification {
  /** Keyed by task, so one job updates one card instead of stacking many. */
  key: string;
  tone: TaskNotificationTone;
  titleKey: TranslationKey;
  description?: string;
  progress?: number;
  life: "short" | "long" | "persistent";
}

/** Job types worth telling somebody about, and what to call them. */
const TASK_TITLE_KEYS: Record<string, TranslationKey> = {
  "library.scan": "tasks.libraryScan",
  "metadata.scan": "tasks.metadataScan",
  "metadata.refresh": "tasks.metadataRefresh",
  "trickplay.generate": "tasks.trickplayGenerate",
  // The queue calls this media.probe; naming it probe.run here meant every
  // probe reported itself as unspecified "background work".
  "media.probe": "tasks.probeRun",
};

export function getTaskTitleKey(type: string): TranslationKey {
  return TASK_TITLE_KEYS[type] ?? "tasks.backgroundWork";
}

/**
 * What a single task should say right now, or null if it should say nothing.
 *
 * A queued task is deliberately silent: work that has not started yet is not
 * news, and announcing it would mean every scan produced a card that sat at
 * zero for as long as the queue was busy.
 */
export function describeTask(task: TaskDto): TaskNotification | null {
  const titleKey = getTaskTitleKey(task.type);
  const key = `task:${task.id}`;

  if (task.status === "running") {
    return {
      key,
      tone: "progress",
      titleKey,
      ...(task.progressMessage ? { description: task.progressMessage } : {}),
      progress: Math.min(100, Math.max(0, task.progress)),
      // Held until the job ends, whereupon this same card is replaced by the
      // outcome rather than a second one appearing beside it.
      life: "persistent",
    };
  }

  if (task.status === "succeeded") {
    return {
      key,
      tone: "success",
      titleKey,
      ...(summariseResult(task) ? { description: summariseResult(task) } : {}),
      life: "long",
    };
  }

  if (task.status === "failed") {
    return {
      key,
      tone: "error",
      titleKey,
      ...(task.error ? { description: task.error } : {}),
      life: "persistent",
    };
  }

  return null;
}

/**
 * A one-line result from whatever the job chose to report.
 *
 * Counts are the useful part of a scan — how much was found, how much changed —
 * so they are read generically rather than per job type: a new job that reports
 * counts gets a summary without this needing to know about it.
 */
export function summariseResult(task: TaskDto): string | undefined {
  const result = task.result;
  if (!result) return undefined;

  const parts = Object.entries(result)
    .filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && entry[1] > 0,
    )
    .slice(0, 4)
    .map(([name, value]) => `${humanise(name)}: ${value}`);

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function humanise(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Which tasks have something new to say since the last poll.
 *
 * A finished task keeps appearing in the list for a while, so without this the
 * same success card would be re-announced on every poll and never expire.
 */
export function selectChangedTasks(
  tasks: readonly TaskDto[],
  seen: ReadonlyMap<string, string>,
  /**
   * The first poll after the page loaded.
   *
   * Everything is unseen then, so without this a reload replays the whole
   * recent history — every scan that ever finished, every failure from days
   * ago — as though it had just happened. Work still running is the exception:
   * that is happening now and is the reason to look.
   */
  isFirstPoll = false,
): { changed: TaskDto[]; next: Map<string, string> } {
  const next = new Map<string, string>();
  const changed: TaskDto[] = [];

  for (const task of tasks) {
    // Progress is part of the signature so a running job keeps updating, but a
    // finished one settles and stops.
    const signature =
      task.status === "running"
        ? `running:${task.progress}:${task.progressMessage ?? ""}`
        : task.status;

    next.set(task.id, signature);
    if (seen.get(task.id) === signature) continue;
    if (isFirstPoll && task.status !== "running") continue;
    changed.push(task);
  }

  return { changed, next };
}
