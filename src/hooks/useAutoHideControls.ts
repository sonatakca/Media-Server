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
  const isPlayingRef = useRef(isPlaying);
  const disabledRef = useRef(disabled);
  const isHoveringControlsRef = useRef(false);
  const wasPlayingRef = useRef(isPlaying);
  const playStartDelayMsRef = useRef(playStartDelayMs);
  const interactionDelayMsRef = useRef(interactionDelayMs);

  isPlayingRef.current = isPlaying;
  disabledRef.current = disabled;
  playStartDelayMsRef.current = playStartDelayMs;
  interactionDelayMsRef.current = interactionDelayMs;

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(
    (delayMs: number) => {
      clearHideTimer();

      if (disabledRef.current || !isPlayingRef.current || isHoveringControlsRef.current) {
        setAreControlsVisible(true);
        return;
      }

      hideTimerRef.current = window.setTimeout(() => {
        if (!isHoveringControlsRef.current) {
          setAreControlsVisible(false);
        }

        hideTimerRef.current = null;
      }, delayMs);
    },
    [clearHideTimer],
  );

  const showControls = useCallback(() => {
    setAreControlsVisible(true);

    if (!disabledRef.current && isPlayingRef.current && !isHoveringControlsRef.current) {
      scheduleHide(interactionDelayMsRef.current);
    }
  }, [scheduleHide]);

  const keepControlsVisible = useCallback(() => {
    clearHideTimer();
    isHoveringControlsRef.current = true;
    setIsHoveringControls(true);
    setAreControlsVisible(true);
  }, [clearHideTimer]);

  const releaseControlsHover = useCallback(() => {
    isHoveringControlsRef.current = false;
    setIsHoveringControls(false);

    if (!disabledRef.current && isPlayingRef.current) {
      scheduleHide(interactionDelayMsRef.current);
    }
  }, [scheduleHide]);

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