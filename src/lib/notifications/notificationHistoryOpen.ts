export const NOTIFICATION_HISTORY_OPEN_EVENT =
  "seyirlik:notification-history-open";

/**
 * Opens the notification history from anywhere: it is reached from the
 * account menu, which unmounts as it closes, so the panel lives in the
 * navbar and listens for this. Focus goes back to `returnFocusTo` on close.
 */
export function openNotificationHistory(returnFocusTo?: HTMLElement | null) {
  window.dispatchEvent(
    new CustomEvent<HTMLElement | null>(NOTIFICATION_HISTORY_OPEN_EVENT, {
      detail: returnFocusTo ?? null,
    }),
  );
}
