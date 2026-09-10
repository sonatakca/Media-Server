import type { TaskDetail } from "./taskNotifications";
import { randomUuid } from "../randomId";

/**
 * Transient feedback, held outside React.
 *
 * A module that is not a component — an API wrapper, a background poller —
 * still needs to say what happened, so the store is a plain subscribable object
 * rather than a context. Components read it through `useSyncExternalStore`.
 */

export type NotificationTone =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "progress";

/**
 * How long a notification stays.
 *
 * `short` is for something the viewer already knows they did; `long` is for
 * something they may have looked away from; `persistent` is for anything they
 * would be worse off missing, and only a click dismisses it.
 */
export type NotificationLife = "short" | "long" | "persistent";

export const NOTIFICATION_LIFETIMES_MS: Record<
  Exclude<NotificationLife, "persistent">,
  number
> = {
  short: 4_000,
  long: 9_000,
};

export interface SeyirlikNotification {
  id: string;
  tone: NotificationTone;
  title: string;
  description?: string;
  /** 0–100 while work is in flight; absent when there is nothing to measure. */
  progress?: number;
  task?: TaskDetail;
  life: NotificationLife;
  createdAt: number;
  firstShownAt?: number;
  updatedAt?: number;
}

export interface NotifyInput {
  tone?: NotificationTone;
  title: string;
  description?: string;
  progress?: number;
  task?: TaskDetail;
  life?: NotificationLife;
  /**
   * Replaces any earlier notification with the same key instead of stacking a
   * second one. A scan reporting every few per cent must not leave a column of
   * near-identical cards behind it.
   */
  key?: string;
  /** Update a retained history entry without raising another toast. */
  historyOnly?: boolean;
}

type Listener = () => void;

let notifications: SeyirlikNotification[] = [];
let history: SeyirlikNotification[] = [];
const MAX_HISTORY = 100;
const keyed = new Map<string, string>();
const listeners = new Set<Listener>();

/** Beyond this the oldest are dropped; nobody reads a hundred of them. */
const MAX_NOTIFICATIONS = 12;

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeToNotifications(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Newest first, which is the order they are shown in. */
export function getNotifications(): SeyirlikNotification[] {
  return notifications;
}

export function getNotificationHistory(): SeyirlikNotification[] {
  return history;
}

export function clearNotificationHistory(): void {
  history = [];
  keyed.clear();
  emit();
}

function retain(entry: SeyirlikNotification): void {
  history = [entry, ...history.filter((item) => item.id !== entry.id)].slice(
    0,
    MAX_HISTORY,
  );
  for (const [key, id] of keyed) {
    if (
      !history.some((item) => item.id === id) &&
      !notifications.some((item) => item.id === id)
    )
      keyed.delete(key);
  }
}

function defaultLife(tone: NotificationTone): NotificationLife {
  // Progress has no natural end until the work does, and an error is the one
  // thing a viewer should never miss because they blinked.
  if (tone === "progress" || tone === "error") return "persistent";
  return tone === "warning" ? "long" : "short";
}

export function notify(input: NotifyInput): string {
  const tone = input.tone ?? "info";
  const key =
    input.key ?? `message:${tone}:${input.title}:${input.description ?? ""}`;
  const existingId = keyed.get(key);
  const existing = history.find((entry) => entry.id === existingId);

  if (existingId && existing) {
    if (
      !input.historyOnly &&
      !notifications.some((entry) => entry.id === existingId)
    )
      notifications = [existing, ...notifications].slice(0, MAX_NOTIFICATIONS);
    const sameAttempt =
      input.task &&
      existing.task?.attempts === input.task.attempts &&
      existing.task.status === input.task.status;
    const progress =
      sameAttempt &&
      input.task?.status === "running" &&
      input.progress !== undefined &&
      existing.progress !== undefined
        ? Math.max(existing.progress, input.progress)
        : input.progress;
    updateNotification(existingId, {
      updatedAt: Date.now(),
      tone,
      title: input.title,
      // Cleared rather than kept: replacing a card is saying something new, and
      // an old description under a new title would be a lie.
      description: input.description,
      progress,
      task: input.task,
      life: input.life ?? defaultLife(tone),
      // A task outcome starts its lifetime once. Routine updates within the
      // same state/attempt keep that deadline; generic replacements restart.
      createdAt: sameAttempt ? existing.createdAt : Date.now(),
    });
    return existingId;
  }

  const notification: SeyirlikNotification = {
    id: randomUuid(),
    tone,
    title: input.title,
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    task: input.task,
    life: input.life ?? defaultLife(tone),
    createdAt: Date.now(),
    firstShownAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (!input.historyOnly)
    notifications = [notification, ...notifications].slice(
      0,
      MAX_NOTIFICATIONS,
    );
  retain(notification);
  keyed.set(key, notification.id);
  emit();
  return notification.id;
}

export function updateNotification(
  id: string,
  patch: Partial<Omit<SeyirlikNotification, "id">>,
): void {
  let changed = false;
  notifications = notifications.map((entry) => {
    if (entry.id !== id) return entry;
    changed = true;
    return { ...entry, ...patch };
  });
  const previous = history.find((entry) => entry.id === id);
  if (previous) {
    retain({ ...previous, ...patch });
    changed = true;
  }
  if (changed) emit();
}

export function dismissNotification(id: string): void {
  const before = notifications.length;
  notifications = notifications.filter((entry) => entry.id !== id);
  if (notifications.length !== before) emit();
}

export function dismissAllNotifications(): void {
  if (notifications.length === 0) return;
  notifications = [];
  emit();
}

/** Test seam; production code never needs to reset the store. */
export function resetNotificationsForTests(): void {
  notifications = [];
  history = [];
  keyed.clear();
  listeners.clear();
}
