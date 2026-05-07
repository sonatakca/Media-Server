import { useCallback, useEffect, useState } from "react";

interface AutoHideControlsOptions {
  isPlaying: boolean;
  disabled?: boolean;
  delayMs?: number;
}

export function useAutoHideControls({
  isPlaying,
  disabled = false,
  delayMs = 2800,
}: AutoHideControlsOptions) {
  const [areControlsVisible, setAreControlsVisible] = useState(true);

  const showControls = useCallback(() => {
    setAreControlsVisible(true);
  }, []);

  useEffect(() => {
    if (disabled || !isPlaying) {
      setAreControlsVisible(true);
      return undefined;
    }

    const timer = window.setTimeout(() => setAreControlsVisible(false), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, disabled, isPlaying, areControlsVisible]);

  return {
    areControlsVisible,
    showControls,
    setAreControlsVisible,
  };
}
