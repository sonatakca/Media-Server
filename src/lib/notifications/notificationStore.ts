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
  life: NotificationLife;
  createdAt: number;
}

export interface NotifyInput {
  tone?: NotificationTone;
  title: string;
  description?: string;
  progress?: number;
  life?: NotificationLife;
  /**
   * Replaces any earlier notification with the same key instead of stacking a
   * second one. A scan reporting every few per cent must not leave a column of
   * near-identical cards behind it.
   */
  key?: string;
}

type Listener = () => void;

let notifications: SeyirlikNotification[] = [];
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

function defaultLife(tone: NotificationTone): NotificationLife {
  // Progress has no natural end until the work does, and an error is the one
  // thing a viewer should never miss because they blinked.
  if (tone === "progress" || tone === "error") return "persistent";
  return tone === "warning" ? "long" : "short";
}

export function notify(input: NotifyInput): string {
  const tone = input.tone ?? "info";
  const existingId = input.key ? keyed.get(input.key) : undefined;

  if (existingId && notifications.some((entry) => entry.id === existingId)) {
    updateNotification(existingId, {
      tone,
      title: input.title,
      // Cleared rather than kept: replacing a card is saying something new, and
      // an old description under a new title would be a lie.
      description: input.description,
      progress: input.progress,
      life: input.life ?? defaultLife(tone),
      // The clock restarts. Without this the outcome of a long job inherits the
      // age of its first progress update and expires the moment it appears.
      createdAt: Date.now(),
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
    life: input.life ?? defaultLife(tone),
    createdAt: Date.now(),
  };

  notifications = [notification, ...notifications].slice(0, MAX_NOTIFICATIONS);
  if (input.key) keyed.set(input.key, notification.id);
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
  if (changed) emit();
}

export function dismissNotification(id: string): void {
  const before = notifications.length;
  notifications = notifications.filter((entry) => entry.id !== id);
  for (const [key, value] of keyed) {
    if (value === id) keyed.delete(key);
  }
  if (notifications.length !== before) emit();
}

export function dismissAllNotifications(): void {
  if (notifications.length === 0) return;
  notifications = [];
  keyed.clear();
  emit();
}

/** Test seam; production code never needs to reset the store. */
export function resetNotificationsForTests(): void {
  notifications = [];
  keyed.clear();
  listeners.clear();
}
