/**
 * Whether anything on the page is loading right now, for the navbar wordmark
 * to cycle through its colours while it is.
 *
 * Sources register themselves: own-API requests (unless marked background, so
 * a poll does not animate the logo every few seconds) and every mounted
 * loading spinner, which also covers lazy routes behind a Suspense fallback.
 */
let pendingCount = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Marks one piece of loading as started; call the returned function once it ends. */
export function beginLoadingActivity(): () => void {
  pendingCount += 1;
  if (pendingCount === 1) notify();

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    pendingCount -= 1;
    if (pendingCount === 0) notify();
  };
}

export function trackLoadingActivity<T>(promise: Promise<T>): Promise<T> {
  const end = beginLoadingActivity();
  promise.then(end, end);
  return promise;
}

export function isLoadingActivityPending(): boolean {
  return pendingCount > 0;
}

export function subscribeLoadingActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
