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
  /**
   * Whether this card is at the top or the bottom of the run of laid-out
   * cards, which is the only place the column is allowed a rounded corner.
   *
   * A pile is one block of cards lying on each other. Given a corner each,
   * every card in the middle of the run cut two notches of page out of the
   * seam it shares with its neighbour — which reads as a list of torn-off
   * strips rather than as one thing.
   */
  isColumnTop: boolean;
  isColumnBottom: boolean;
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

/** Each collapsed card shows this much of itself above the one in front. */
const COLLAPSED_STEP_PX = 6;
/** Only this many peek out; below that they are indistinguishable. */
const MAX_PEEKING = 2;
/**
 * How far the peeking cards reach above the card at the front.
 *
 * The column reserves exactly this much room above its first row: enough for
 * the pile to show, and not a pixel more, so the rounded corner and the shadow
 * of the column sit on the pile rather than on empty space above it.
 */
export const COLLAPSED_HEADROOM_PX = COLLAPSED_STEP_PX * MAX_PEEKING;

/**
 * Lays out the notification column.
 *
 * Oldest at the front, newer ones tucked in behind it. The store keeps the
 * newest at the head of its list, so the pile is built from the back of that
 * list forwards.
 *
 * The card at the front holds its place: whatever arrives next goes *under*
 * the one already being read rather than taking its position, so a card cannot
 * be swapped out from beneath a cursor halfway through a sentence. Read as a
 * column that means the earliest is nearest the anchor at the bottom and the
 * latest is furthest up it — which is also the order the pile opens into.
 */
export function planNotificationStack(
  notifications: readonly SeyirlikNotification[],
  maxExpanded: number = MAX_EXPANDED_NOTIFICATIONS,
): NotificationStack {
  const limit = Math.max(1, maxExpanded);
  const entries: StackedNotification[] = [];
  /*
   * How many cards are laid out rather than piled. The run is read from the
   * anchor upwards, so the first one placed is the bottom of the column and
   * the last one placed is its top — which is the pair of edges the column is
   * rounded at, and nowhere else.
   */
  const laidOut = Math.min(notifications.length, limit);

  [...notifications].reverse().forEach((notification, index) => {
    const collapsedIndex = index - limit;

    if (collapsedIndex < 0) {
      entries.push({
        notification,
        isCollapsed: false,
        offsetY: 0,
        isColumnBottom: index === 0,
        isColumnTop: index === laidOut - 1,
        scale: 1,
        opacity: 1,
        // Later cards paint behind earlier ones, so the front card stays on top.
        zIndex: notifications.length - index,
      });
      return;
    }

    if (collapsedIndex >= MAX_PEEKING) return;

    /*
     * Each step back is a little smaller and a little dimmer, and that is the
     * whole of the depth cue. Dimmer only slightly: a card faded most of the
     * way out stops looking like a card behind another one and starts looking
     * like a rendering fault.
     */
    entries.push({
      notification,
      isCollapsed: true,
      offsetY: -(collapsedIndex + 1) * COLLAPSED_STEP_PX,
      // A strip lying on the pile, never an end of the column itself.
      isColumnBottom: false,
      isColumnTop: false,
      scale: 1 - (collapsedIndex + 1) * 0.03,
      opacity: 1 - (collapsedIndex + 1) * 0.12,
      zIndex: notifications.length - index,
    });
  });

  return {
    entries,
    hiddenCount: Math.max(0, notifications.length - limit - MAX_PEEKING),
  };
}
