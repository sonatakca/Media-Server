import { useCallback, useRef, type RefObject } from "react";
import {
  TOUCH_DOUBLE_TAP_THRESHOLD_MS,
  TOUCH_SEEK_SESSION_TIMEOUT_MS,
} from "./constants";
import type { TouchSeekSessionState, TouchSeekSide } from "./types";

/** Each tap of a double-tap seek moves this far, back on the left, on on the right. */
export const TOUCH_SEEK_STEP_SECONDS = 5;

/**
 * What a tap means, given the taps before it.
 *
 * Once a double tap has started seeking, every further tap on the same side
 * seeks again without waiting for a pair; a tap on the other side ends that
 * run. Otherwise two taps on one side inside the threshold are a double tap,
 * and anything else is an ordinary tap.
 */
export function classifyTouchTap(
  session: Pick<
    TouchSeekSessionState,
    "isActive" | "lastTapSide" | "lastTapTime"
  >,
  side: TouchSeekSide,
  now: number,
): "continue-seek" | "double-tap" | "single" {
  if (session.isActive && session.lastTapSide === side) return "continue-seek";
  if (
    !session.isActive &&
    session.lastTapSide === side &&
    now - session.lastTapTime < TOUCH_DOUBLE_TAP_THRESHOLD_MS
  ) {
    return "double-tap";
  }
  return "single";
}

/**
 * Double-tap to seek on a touch screen, the way every phone video player does.
 *
 * `handleTouchTap` answers "seeked" when the tap moved the playhead, "tap"
 * when it was an ordinary tap the player should act on, and null when the
 * player has no layout to measure the tap against.
 */
export function useTouchSeek(containerRef: RefObject<HTMLDivElement | null>) {
  const touchSeekSessionRef = useRef<TouchSeekSessionState>({
    lastTapTime: 0,
    lastTapSide: null,
    isActive: false,
    accumulatedSeconds: 0,
    timeoutId: null,
  });

  const clearTouchSeekSessionTimeout = useCallback(() => {
    if (touchSeekSessionRef.current.timeoutId !== null) {
      window.clearTimeout(touchSeekSessionRef.current.timeoutId);
      touchSeekSessionRef.current.timeoutId = null;
    }
  }, []);

  const resetTouchSeekSession = useCallback(() => {
    clearTouchSeekSessionTimeout();

    touchSeekSessionRef.current.lastTapTime = 0;
    touchSeekSessionRef.current.lastTapSide = null;
    touchSeekSessionRef.current.isActive = false;
    touchSeekSessionRef.current.accumulatedSeconds = 0;
  }, [clearTouchSeekSessionTimeout]);

  const scheduleTouchSeekSessionExpiry = () => {
    clearTouchSeekSessionTimeout();

    touchSeekSessionRef.current.timeoutId = window.setTimeout(() => {
      touchSeekSessionRef.current.lastTapTime = 0;
      touchSeekSessionRef.current.lastTapSide = null;
      touchSeekSessionRef.current.isActive = false;
      touchSeekSessionRef.current.accumulatedSeconds = 0;
      touchSeekSessionRef.current.timeoutId = null;
    }, TOUCH_SEEK_SESSION_TIMEOUT_MS);
  };

  const seekByTouchSide = (
    side: TouchSeekSide,
    now: number,
    seekBy: (seconds: number) => void,
  ) => {
    const seconds =
      side === "left" ? -TOUCH_SEEK_STEP_SECONDS : TOUCH_SEEK_STEP_SECONDS;
    const session = touchSeekSessionRef.current;
    const isContinuingSameSide = session.lastTapSide === side;

    session.lastTapTime = now;
    session.lastTapSide = side;
    session.isActive = true;
    session.accumulatedSeconds = isContinuingSameSide
      ? session.accumulatedSeconds + seconds
      : seconds;

    seekBy(seconds);
    scheduleTouchSeekSessionExpiry();
  };

  const handleTouchTap = (
    clientX: number,
    now: number,
    seekBy: (seconds: number) => void,
  ): "seeked" | "tap" | null => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    const side: TouchSeekSide =
      clientX - bounds.left < bounds.width / 2 ? "left" : "right";
    const session = touchSeekSessionRef.current;

    // A tap on the other side ends a seeking run before it is judged afresh.
    if (session.isActive && session.lastTapSide !== side) {
      resetTouchSeekSession();
    }

    const meaning = classifyTouchTap(session, side, now);
    if (meaning === "continue-seek") {
      seekByTouchSide(side, now, seekBy);
      return "seeked";
    }
    if (meaning === "double-tap") {
      session.accumulatedSeconds = 0;
      seekByTouchSide(side, now, seekBy);
      return "seeked";
    }

    resetTouchSeekSession();
    session.lastTapTime = now;
    session.lastTapSide = side;
    return "tap";
  };

  return { resetTouchSeekSession, handleTouchTap };
}
