import { useCallback, useEffect, useRef, useState } from "react";

interface AutoHideControlsOptions {
  isPlaying: boolean;
  disabled?: boolean;
  playStartDelayMs?: number;
  interactionDelayMs?: number;
}

export function useAutoHideControls({
  isPlaying,
  disabled = false,
  playStartDelayMs = 100,
  interactionDelayMs = 2400,
}: AutoHideControlsOptions) {
  const [areControlsVisible, setAreControlsVisible] = useState(true);
  const [isHoveringControls, setIsHoveringControls] = useState(false);

  const hideTimerRef = useRef<number | null>(null);
  const wasPlayingRef = useRef(isPlaying);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(
    (delayMs: number) => {
      clearHideTimer();

      if (disabled || !isPlaying || isHoveringControls) {
        setAreControlsVisible(true);
        return;
      }

      hideTimerRef.current = window.setTimeout(() => {
        if (!isHoveringControls) {
          setAreControlsVisible(false);
        }

        hideTimerRef.current = null;
      }, delayMs);
    },
    [clearHideTimer, disabled, isHoveringControls, isPlaying],
  );

  const showControls = useCallback(() => {
    setAreControlsVisible(true);

    if (!disabled && isPlaying && !isHoveringControls) {
      scheduleHide(interactionDelayMs);
    }
  }, [disabled, interactionDelayMs, isHoveringControls, isPlaying, scheduleHide]);

  const keepControlsVisible = useCallback(() => {
    clearHideTimer();
    setIsHoveringControls(true);
    setAreControlsVisible(true);
  }, [clearHideTimer]);

  const releaseControlsHover = useCallback(() => {
    setIsHoveringControls(false);
  }, []);

  useEffect(() => {
    if (disabled || !isPlaying) {
      clearHideTimer();
      setAreControlsVisible(true);
      wasPlayingRef.current = isPlaying;
      return undefined;
    }

    if (isHoveringControls) {
      clearHideTimer();
      setAreControlsVisible(true);
      wasPlayingRef.current = isPlaying;
      return undefined;
    }

    const hasJustStartedPlaying = !wasPlayingRef.current && isPlaying;

    setAreControlsVisible(true);
    scheduleHide(hasJustStartedPlaying ? playStartDelayMs : interactionDelayMs);

    wasPlayingRef.current = isPlaying;

    return undefined;
  }, [
    clearHideTimer,
    disabled,
    interactionDelayMs,
    isHoveringControls,
    isPlaying,
    playStartDelayMs,
    scheduleHide,
  ]);

  useEffect(() => {
    return () => {
      clearHideTimer();
    };
  }, [clearHideTimer]);

  return {
    areControlsVisible,
    showControls,
    setAreControlsVisible,
    keepControlsVisible,
    releaseControlsHover,
  };
}