import type { TaskDto } from "../../api/ownApi/dto";
import type { TranslationKey } from "../../i18n/translations";
import {
  presentTask,
  safeEpisodeCode,
  safeTaskLabel,
  type TaskPresentation,
} from "./taskPresentation";

export interface TaskDetail extends TaskPresentation {
  titleKey?: TranslationKey;
  status: TaskDto["status"] | "retrying" | "waiting-for-storage" | "paused";
  attempts: number;
  maxAttempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  errorKey?: TranslationKey;
}
export interface TaskNotification {
  key: string;
  tone: "info" | "success" | "error" | "progress" | "warning";
  titleKey: TranslationKey;
  progress?: number;
  task: TaskDetail;
  life: "long" | "persistent";
}
const TASK_TITLE_KEYS: Record<string, TranslationKey> = {
  "library.scan": "tasks.libraryScan",
  "media.probe": "tasks.probeRun",
  "metadata.scan": "tasks.metadataScan",
  "metadata.refresh": "tasks.metadataRefresh",
  "trickplay.generate": "tasks.trickplayGenerate",
  "media.process": "tasks.mediaProcess",
  "nfo.export.item": "tasks.nfoItem",
  "nfo.export.library": "tasks.nfoLibrary",
};
export function getTaskTitleKey(type: string): TranslationKey {
  return TASK_TITLE_KEYS[type] ?? "tasks.backgroundWork";
}
/**
 * The figure a card is allowed to show for a percentage.
 *
 * Floored, never rounded: 99.6% is not finished, and "100%" on a job that is
 * still running is the one number a viewer would act on. `decimals` is for
 * figures whose underlying unit is fine enough to warrant it — an encode is
 * measured in media seconds, where a whole per cent of a feature is a minute
 * and a half of film.
 */
export function progressPercent(value: number, decimals = 0): number {
  const scale = 10 ** Math.max(0, Math.min(3, Math.trunc(decimals)));
  return Math.floor(Math.min(100, Math.max(0, value)) * scale) / scale;
}
/**
 * An encode's own figures, kept only when they describe something possible.
 *
 * Nothing downstream re-checks these: a total of zero would divide, and a
 * completed time past the total would report more than a hundred per cent of a
 * film.
 */
function validEncoding(
  encoding: TaskPresentation["encoding"],
): TaskPresentation["encoding"] {
  return encoding &&
    Number.isFinite(encoding.completedSeconds) &&
    Number.isFinite(encoding.totalSeconds) &&
    encoding.totalSeconds > 0 &&
    encoding.completedSeconds >= 0 &&
    encoding.completedSeconds <= encoding.totalSeconds
    ? encoding
    : undefined;
}

/** A phase's own position, kept only when it is a real fraction of one. */
function validFraction(value: number | undefined): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : undefined;
}

/** A duration a card may show: real, not negative, and not a geological age. */
function validSeconds(value: number | undefined): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < 60 * 60 * 24 * 30
    ? Math.round(value)
    : undefined;
}

/** The single fraction (queue 0..1) -> percentage (card 0..100) boundary. */
export function normalizeTaskProgress(fraction: number): number | undefined {
  return typeof fraction === "number" && Number.isFinite(fraction)
    ? Math.min(1, Math.max(0, fraction)) * 100
    : undefined;
}
/**
 * The one media job worth a card, and how many are behind it.
 *
 * The server processes one title at a time, so a dozen queued episodes are one
 * thing happening — a waiting line — not a dozen events. Reporting each of them
 * produced a column of identical "Media processing · Queued" cards that said
 * nothing about which titles they were or when any of them would run.
 */
export interface ProcessingLead {
  taskId: string;
  /** Titles waiting behind the lead, which its card counts on their behalf. */
  queuedCount: number;
  /** Ids the lead answers for; none of them raises a card of its own. */
  spokenFor: readonly string[];
}

/**
 * Still somewhere in the processing line, as the *card* reckons it.
 *
 * Never the raw queue status: holding a queued title ends its queue attempt as
 * `succeeded` carrying a cancelled result, so eighteen paused episodes look to
 * the queue like eighteen finished ones. Reading it that way is what turned a
 * single press of "pause all" into eighteen cards, each announcing a title as
 * cancelled, ordered from the back of the line.
 */
const LINE_STATUSES = new Set<TaskDetail["status"]>([
  "running",
  "queued",
  "retrying",
  "paused",
  "waiting-for-storage",
]);

export function selectProcessingLead(
  tasks: readonly TaskDto[],
): ProcessingLead | null {
  const line = tasks.flatMap((task) => {
    if (task.type !== "media.process") return [];
    const status = describeTask(task).task.status;
    return LINE_STATUSES.has(status) ? [{ task, status }] : [];
  });
  if (line.length === 0) return null;
  // Whatever is actually encoding leads; with nothing running, the title that
  // has waited longest is the one that runs next — the same title the page
  // puts at the head of its own list.
  const lead =
    line.find((entry) => entry.status === "running") ??
    line.reduce((earliest, entry) =>
      (Date.parse(entry.task.queuedAt) || 0) <
      (Date.parse(earliest.task.queuedAt) || 0)
        ? entry
        : earliest,
    );
  const behind = line.filter((entry) => entry.task.id !== lead.task.id);
  return {
    taskId: lead.task.id,
    queuedCount: behind.length,
    spokenFor: behind.map((entry) => entry.task.id),
  };
}

/** Whether the lead's card already speaks for this task. */
export function isSpokenForByLead(
  task: TaskDto,
  lead: ProcessingLead | null,
): boolean {
  return lead !== null && lead.spokenFor.includes(task.id);
}

export function describeTask(task: TaskDto, queuedCount = 0): TaskNotification {
  const presentation =
    task.presentation ??
    presentTask(
      task.type,
      task.status === "running" ? task.progressMessage : null,
      task.status === "succeeded" ? task.result : null,
    );
  const outcome = presentation.outcome;
  const status =
    outcome === "waiting-for-storage" ||
    outcome === "paused" ||
    outcome === "cancelled"
      ? outcome
      : outcome === "failed"
        ? "failed"
        : task.status === "queued" && task.attempts > 0
          ? "retrying"
          : task.status;
  const active =
    status === "running" ||
    status === "queued" ||
    status === "retrying" ||
    status === "paused";
  /*
   * A held encoder keeps its position. Everything measured from a *rate* —
   * the remaining time below — is withdrawn the moment the work stops, but
   * where it stopped is the thing a person pausing deliberately wants to see.
   */
  const measurable = status === "running" || status === "paused";
  const encoding = measurable
    ? validEncoding(presentation.encoding)
    : undefined;
  const phaseFraction = measurable
    ? validFraction(presentation.phaseFraction)
    : undefined;
  /*
   * The current phase's own measure, and nothing else: media seconds over
   * media seconds while the picture is encoding, and the phase's own fraction
   * for every phase after it — each one exact, and each one named on the line
   * below the figure. The queue's own progress weights whole stages against
   * each other, so it moves in jumps that mean nothing to a viewer and is
   * never shown as a number.
   */
  const measured = encoding
    ? (encoding.completedSeconds / encoding.totalSeconds) * 100
    : phaseFraction !== undefined
      ? phaseFraction * 100
      : undefined;
  const detail: TaskDetail = {
    ...presentation,
    titleKey: getTaskTitleKey(task.type),
    subject: presentation.subject
      ? {
          ...presentation.subject,
          label: safeTaskLabel(presentation.subject.label),
          code: safeEpisodeCode(presentation.subject.code),
          detail: safeTaskLabel(presentation.subject.detail),
        }
      : undefined,
    stage: measurable ? presentation.stage : undefined,
    counts: status === "running" ? presentation.counts : undefined,
    encoding,
    phaseFraction,
    determinate: measured !== undefined || presentation.determinate,
    remainingSeconds:
      status === "running"
        ? validSeconds(presentation.remainingSeconds)
        : undefined,
    metrics: status === "failed" ? [] : presentation.metrics,
    status,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    errorKey:
      status === "failed"
        ? presentation.errorCode
          ? `tasks.error.${presentation.errorCode}`
          : "tasks.safeFailure"
        : undefined,
  };
  return {
    key: `task:${task.id}`,
    titleKey: getTaskTitleKey(task.type),
    task: {
      ...detail,
      ...(queuedCount > 0 ? { queuedCount } : {}),
    },
    tone:
      status === "failed"
        ? "error"
        : status === "running"
          ? "progress"
          : status === "succeeded"
            ? (outcome && outcome !== "matched") ||
              detail.metrics?.some(
                ({ metric, value }) =>
                  (metric === "failed" || metric === "skippedConflict") &&
                  value > 0,
              )
              ? "warning"
              : "success"
            : status === "waiting-for-storage" ||
                status === "retrying" ||
                status === "paused"
              ? "warning"
              : "info",
    // Legacy consumers still get the corrected unit; the card uses determinate
    // to suppress stage weights and initial queue zeroes from real producers.
    progress: measurable
      ? (measured ?? normalizeTaskProgress(task.progress))
      : undefined,
    life:
      active || status === "failed" || status === "waiting-for-storage"
        ? "persistent"
        : "long",
  };
}
export function selectChangedTasks(
  tasks: readonly TaskDto[],
  seen: ReadonlyMap<string, string>,
  isFirstPoll = false,
): { changed: TaskDto[]; next: Map<string, string> } {
  const next = new Map(seen);
  const changed: TaskDto[] = [];
  for (const task of tasks) {
    const described = describeTask(task);
    const active =
      task.status === "running" ||
      task.status === "queued" ||
      described.task.status === "waiting-for-storage";
    const signature = JSON.stringify(described);
    next.set(task.id, signature);
    if (seen.get(task.id) === signature) continue;
    if (isFirstPoll && !active) continue;
    // A previously unseen historical outcome must not replay if pagination
    // reveals it after the first poll either.
    if (!seen.has(task.id) && !active) continue;
    changed.push(task);
  }
  return { changed, next };
}
