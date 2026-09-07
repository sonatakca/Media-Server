/*
 * The bottom-right corner is shared ground. The hero's carousel control sits
 * there whenever a carousel hero is on screen, and the notification pile lives
 * there on every page. Neither can measure the other — the carousel renders
 * into a portal on document.body and the pile is mounted by the app shell — so
 * whoever occupies the corner publishes how much of it is taken, and the pile
 * stacks on top of that rather than through it.
 *
 * A CSS custom property rather than React context: the pile only ever needs
 * the number inside a calc(), the two components share no ancestor worth
 * threading a provider through, and a length on the document element crosses
 * the portal boundary for free.
 *
 * The value is a distance from the bottom edge of the viewport up to the top of
 * the occupying element, including whatever gap it wants kept above it — so it
 * can be compared directly against another element's `bottom` with max().
 */

const PROPERTY = "--seyirlik-bottom-chrome";

/*
 * How the corner changes hands, shared by both sides of it.
 *
 * The occupant animates itself in and out, and the pile has to travel the
 * distance the occupant frees or takes at exactly the rate the occupant does —
 * anything else reads as two separate movements that happen to overlap. One
 * curve, one duration, one delay, held here rather than copied into each end,
 * because they are only right while they are identical.
 */
export const BOTTOM_CHROME_MOTION = {
  durationS: 1,
  delayS: 0.1,
  ease: [0.25, 1, 0.5, 1] as [number, number, number, number],
};

/*
 * Keyed claims, tallest wins. One hero at a time is the realistic case, but a
 * page that mounts a second one while the first animates away would otherwise
 * have the loser's teardown clear the winner's reservation.
 */
const claims = new Map<string, number>();

/*
 * The property alone tells the pile where to stand, but not that it has moved,
 * and the pile has to travel the distance rather than teleport it. Nothing
 * observes a custom property changing, so the reservation announces itself.
 */
const listeners = new Set<() => void>();

/** The tallest standing claim, in pixels; `0` when the corner is free. */
export function getBottomChrome(): number {
  return claims.size === 0 ? 0 : Math.max(...claims.values());
}

/** Called after every change to the reservation. Returns an unsubscribe. */
export function subscribeToBottomChrome(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function flush() {
  const root = document.documentElement;

  if (claims.size === 0) {
    root.style.removeProperty(PROPERTY);
  } else {
    root.style.setProperty(PROPERTY, `${getBottomChrome()}px`);
  }

  for (const listener of listeners) listener();
}

/** Reserve `heightPx` of the bottom edge under `claimId`. */
export function claimBottomChrome(claimId: string, heightPx: number) {
  if (typeof document === "undefined" || claims.get(claimId) === heightPx) {
    return;
  }

  claims.set(claimId, heightPx);
  flush();
}

export function releaseBottomChrome(claimId: string) {
  if (typeof document === "undefined" || !claims.delete(claimId)) {
    return;
  }

  flush();
}
