import { useEffect, useRef, type RefObject } from "react";

/**
 * How the picture meets the screen.
 *
 * `original` keeps the whole frame inside the safe area, so on a phone held
 * sideways the Dynamic Island and the rounded corners sit beside the film
 * rather than on it. `fill` covers the whole screen and crops what does not
 * fit. Where the safe area is the whole screen — portrait, iPad, desktop —
 * `original` is exactly the letterboxed picture the player always drew.
 */
export type VideoFit = "original" | "fill";

const STORAGE_KEY = "seyirlik:video-fit";

export function readStoredVideoFit(): VideoFit {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "fill"
      ? "fill"
      : "original";
  } catch {
    return "original";
  }
}

export function storeVideoFit(fit: VideoFit): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, fit);
  } catch {
    // Private browsing: the choice still holds for this visit.
  }
}

/** How far two fingers must spread or close before the picture changes. */
const PINCH_RATIO = 1.2;

/** Fingers spreading apart mean fill, closing together mean original. */
export function classifyPinch(
  startDistance: number,
  distance: number,
): VideoFit | null {
  if (startDistance <= 0) return null;
  const ratio = distance / startDistance;
  if (ratio >= PINCH_RATIO) return "fill";
  if (ratio <= 1 / PINCH_RATIO) return "original";
  return null;
}

/** Where a pinch belongs to the control under it, not to the picture. */
const PINCH_IGNORED_ROOTS =
  "[data-player-settings-root], [data-player-queue-root], [data-party-watch-root], [data-subtitle-editor-root], [role='slider']";

function touchDistance(touches: TouchList): number {
  const [first, second] = [touches[0], touches[1]];
  return Math.hypot(
    first.clientX - second.clientX,
    first.clientY - second.clientY,
  );
}

/**
 * Pinching the picture switches between original and fill, as phone video
 * players do.
 *
 * A gesture decides once: it commits as soon as the fingers have moved far
 * enough, and moving them back does not undo it. The page itself never zooms
 * underneath, and `onGesture` runs throughout so the fingers lifting are not
 * read as taps that toggle the controls or seek.
 */
export function usePinchVideoFit(
  containerRef: RefObject<HTMLElement | null>,
  onPinch: (fit: VideoFit) => void,
  onGesture: () => void,
): void {
  const onPinchRef = useRef(onPinch);
  const onGestureRef = useRef(onGesture);

  useEffect(() => {
    onPinchRef.current = onPinch;
    onGestureRef.current = onGesture;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let startDistance = 0;
    let hasDecided = false;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      const target = event.target as Element | null;
      if (target?.closest(PINCH_IGNORED_ROOTS)) {
        startDistance = 0;
        return;
      }
      startDistance = touchDistance(event.touches);
      hasDecided = false;
      onGestureRef.current();
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || startDistance <= 0) return;
      event.preventDefault();
      onGestureRef.current();
      if (hasDecided) return;
      const fit = classifyPinch(startDistance, touchDistance(event.touches));
      if (!fit) return;
      hasDecided = true;
      onPinchRef.current(fit);
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (startDistance <= 0) return;
      onGestureRef.current();
      if (event.touches.length < 2) startDistance = 0;
    };

    // Safari's own pinch, which would otherwise zoom the page.
    const handleGestureStart = (event: Event) => {
      event.preventDefault();
    };

    container.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    container.addEventListener("touchmove", handleTouchMove, {
      passive: false,
    });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("touchcancel", handleTouchEnd);
    container.addEventListener("gesturestart", handleGestureStart);

    return () => {
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
      container.removeEventListener("gesturestart", handleGestureStart);
    };
  }, [containerRef]);
}
