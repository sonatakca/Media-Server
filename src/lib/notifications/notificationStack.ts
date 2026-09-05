import type { SeyirlikNotification } from "./notificationStore";

/**
 * How many notifications are laid out as a readable column before the rest
 * collapse behind them.
 *
 * One. A column that grows without limit eventually covers the page it is
 * reporting on, and every card past the newest is something the viewer has
 * already had a chance to read — so the rest become a pile you can see the
 * depth of, and open when you want it.
 */
export const MAX_EXPANDED_NOTIFICATIONS = 1;

export interface StackedNotification {
  notification: SeyirlikNotification;
  /** Collapsed cards peek out from under the last expanded one. */
  isCollapsed: boolean;
  /** Upward shift in pixels, applied only to collapsed cards. */
  offsetY: number;
  scale: number;
  opacity: number;
  /** Painted back-to-front so a deeper card never covers a shallower one. */
  zIndex: number;
}

export interface NotificationStack {
  entries: StackedNotification[];
  /** How many are hidden behind the peeking ones, for the "+N" label. */
  hiddenCount: number;
}

/** Each collapsed card sits this far above the one in front of it. */
const COLLAPSED_STEP_PX = 8;
/** Only this many peek out; below that they are indistinguishable. */
const MAX_PEEKING = 2;

/**
 * Lays out the notification column.
 *
 * Newest first: the one that just happened is the one being looked for, and
 * putting it at the bottom means its position does not depend on how many came
 * before it.
 */
export function planNotificationStack(
  notifications: readonly SeyirlikNotification[],
  maxExpanded: number = MAX_EXPANDED_NOTIFICATIONS,
): NotificationStack {
  const limit = Math.max(1, maxExpanded);
  const entries: StackedNotification[] = [];

  notifications.forEach((notification, index) => {
    const collapsedIndex = index - limit;

    if (collapsedIndex < 0) {
      entries.push({
        notification,
        isCollapsed: false,
        offsetY: 0,
        scale: 1,
        opacity: 1,
        // Later cards paint behind earlier ones, so the newest stays on top.
        zIndex: notifications.length - index,
      });
      return;
    }

    if (collapsedIndex >= MAX_PEEKING) return;

    // Each step back is smaller and dimmer, which is what reads as depth.
    entries.push({
      notification,
      isCollapsed: true,
      offsetY: -(collapsedIndex + 1) * COLLAPSED_STEP_PX,
      scale: 1 - (collapsedIndex + 1) * 0.04,
      opacity: 1 - (collapsedIndex + 1) * 0.28,
      zIndex: notifications.length - index,
    });
  });

  return {
    entries,
    hiddenCount: Math.max(0, notifications.length - limit - MAX_PEEKING),
  };
}
