import { useCallback, useRef, useState } from "react";
import {
  SEEK_FEEDBACK_FADE_RESET_MS,
  SEEK_FEEDBACK_HIDE_MS,
  SEEK_FEEDBACK_OPPOSITE_HIDE_MS,
  SEEK_FEEDBACK_SPIN_MS,
  initialSeekFeedback,
} from "./constants";
import type {
  SeekFeedbackDirection,
  SeekFeedbackSpinState,
  SeekFeedbackState,
} from "./types";

interface UseSeekFeedbackOptions {
  isPlaying: boolean;
  controlsShouldStayVisible: boolean;
  onHidePlayerChrome: () => void;
}

export function useSeekFeedback({
  isPlaying,
  controlsShouldStayVisible,
  onHidePlayerChrome,
}: UseSeekFeedbackOptions) {
  const [seekFeedback, setSeekFeedback] =
    useState<SeekFeedbackState>(initialSeekFeedback);
  const seekFeedbackHideTimersRef = useRef<
    Record<SeekFeedbackDirection, number | null>
  >({
    backward: null,
    forward: null,
  });
  const seekFeedbackSpinStateRef = useRef<
    Record<SeekFeedbackDirection, SeekFeedbackSpinState>
  >({
    backward: {
      isSpinning: false,
      hasPendingSpin: false,
      finishTimerId: null,
    },
    forward: {
      isSpinning: false,
      hasPendingSpin: false,
      finishTimerId: null,
    },
  });
  const seekFeedbackChromeHideTimerRef = useRef<number | null>(null);

  const clearSeekFeedbackChromeHideTimer = useCallback(() => {
    if (seekFeedbackChromeHideTimerRef.current !== null) {
      window.clearTimeout(seekFeedbackChromeHideTimerRef.current);
      seekFeedbackChromeHideTimerRef.current = null;
    }
  }, []);

  const resetSeekFeedbackSpinState = useCallback(
    (direction: SeekFeedbackDirection) => {
      const spinState = seekFeedbackSpinStateRef.current[direction];

      if (spinState.finishTimerId !== null) {
        window.clearTimeout(spinState.finishTimerId);
      }

      spinState.isSpinning = false;
      spinState.hasPendingSpin = false;
      spinState.finishTimerId = null;
    },
    [],
  );

  const clearSeekFeedbackSpinTimers = useCallback(() => {
    (["backward", "forward"] as const).forEach(resetSeekFeedbackSpinState);
  }, [resetSeekFeedbackSpinState]);

  const clearSeekFeedbackTimers = useCallback(() => {
    (["backward", "forward"] as const).forEach((direction) => {
      if (seekFeedbackHideTimersRef.current[direction] !== null) {
        window.clearTimeout(seekFeedbackHideTimersRef.current[direction]!);
        seekFeedbackHideTimersRef.current[direction] = null;
      }
    });
  }, []);

  const startSeekFeedbackSpin = useCallback(
    (direction: SeekFeedbackDirection) => {
      const spinState = seekFeedbackSpinStateRef.current[direction];

      const beginSpin = () => {
        spinState.isSpinning = true;
        setSeekFeedback((current) => ({
          ...current,
          [direction]: {
            ...current[direction],
            spinPulse: current[direction].spinPulse + 1,
          },
        }));

        if (spinState.finishTimerId !== null) {
          window.clearTimeout(spinState.finishTimerId);
        }

        spinState.finishTimerId = window.setTimeout(() => {
          spinState.finishTimerId = null;

          if (spinState.hasPendingSpin) {
            spinState.hasPendingSpin = false;
            beginSpin();
            return;
          }

          spinState.isSpinning = false;
        }, SEEK_FEEDBACK_SPIN_MS);
      };

      beginSpin();
    },
    [],
  );

  const requestSeekFeedbackSpin = useCallback(
    (direction: SeekFeedbackDirection) => {
      const spinState = seekFeedbackSpinStateRef.current[direction];

      if (spinState.isSpinning) {
        spinState.hasPendingSpin = true;
        return;
      }

      startSeekFeedbackSpin(direction);
    },
    [startSeekFeedbackSpin],
  );

  const hidePlayerChromeWithSeekFeedback = useCallback(() => {
    clearSeekFeedbackChromeHideTimer();

    if (!isPlaying || controlsShouldStayVisible) {
      return;
    }

    seekFeedbackChromeHideTimerRef.current = window.setTimeout(() => {
      onHidePlayerChrome();
      seekFeedbackChromeHideTimerRef.current = null;
    }, SEEK_FEEDBACK_HIDE_MS);
  }, [
    clearSeekFeedbackChromeHideTimer,
    controlsShouldStayVisible,
    isPlaying,
    onHidePlayerChrome,
  ]);

  const triggerSeekFeedback = useCallback(
    (seconds: number) => {
      if (seconds === 0) {
        return;
      }

      const direction: SeekFeedbackDirection =
        seconds < 0 ? "backward" : "forward";
      const oppositeDirection: SeekFeedbackDirection =
        direction === "backward" ? "forward" : "backward";
      const amount = Math.abs(seconds);

      resetSeekFeedbackSpinState(oppositeDirection);

      if (seekFeedbackHideTimersRef.current[oppositeDirection] !== null) {
        window.clearTimeout(
          seekFeedbackHideTimersRef.current[oppositeDirection]!,
        );
      }

      seekFeedbackHideTimersRef.current[oppositeDirection] = window.setTimeout(
        () => {
          setSeekFeedback((current) => ({
            ...current,
            [oppositeDirection]: {
              ...current[oppositeDirection],
              visible: false,
            },
          }));

          window.setTimeout(() => {
            setSeekFeedback((current) => {
              if (current[oppositeDirection].visible) {
                return current;
              }

              return {
                ...current,
                [oppositeDirection]: {
                  ...current[oppositeDirection],
                  amount: 0,
                },
              };
            });
          }, SEEK_FEEDBACK_FADE_RESET_MS);

          seekFeedbackHideTimersRef.current[oppositeDirection] = null;
        },
        SEEK_FEEDBACK_OPPOSITE_HIDE_MS,
      );

      setSeekFeedback((current) => {
        const currentDirection = current[direction];

        return {
          ...current,
          [direction]: {
            ...currentDirection,
            amount: currentDirection.amount + amount,
            visible: true,
            pulse: currentDirection.pulse + 1,
          },
        };
      });

      requestSeekFeedbackSpin(direction);

      if (seekFeedbackHideTimersRef.current[direction] !== null) {
        window.clearTimeout(seekFeedbackHideTimersRef.current[direction]!);
      }

      seekFeedbackHideTimersRef.current[direction] = window.setTimeout(() => {
        setSeekFeedback((current) => ({
          ...current,
          [direction]: {
            ...current[direction],
            visible: false,
          },
        }));

        window.setTimeout(() => {
          setSeekFeedback((current) => {
            if (current[direction].visible) {
              return current;
            }

            return {
              ...current,
              [direction]: {
                ...current[direction],
                amount: 0,
              },
            };
          });
        }, SEEK_FEEDBACK_FADE_RESET_MS);

        seekFeedbackHideTimersRef.current[direction] = null;
      }, SEEK_FEEDBACK_HIDE_MS);
    },
    [requestSeekFeedbackSpin, resetSeekFeedbackSpinState],
  );

  return {
    clearSeekFeedbackChromeHideTimer,
    clearSeekFeedbackSpinTimers,
    clearSeekFeedbackTimers,
    hidePlayerChromeWithSeekFeedback,
    seekFeedback,
    triggerSeekFeedback,
  };
}
