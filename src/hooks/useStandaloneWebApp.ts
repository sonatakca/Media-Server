import { useEffect, useState } from "react";
import { isStandaloneWebApp } from "../lib/displayMode";

export function useStandaloneWebApp(): boolean {
  const [isWebApp, setIsWebApp] = useState(false);

  useEffect(() => {
    const updateDisplayMode = () => {
      setIsWebApp(isStandaloneWebApp());
    };

    updateDisplayMode();

    const mediaQuery = window.matchMedia?.("(display-mode: standalone)");

    mediaQuery?.addEventListener?.("change", updateDisplayMode);

    return () => {
      mediaQuery?.removeEventListener?.("change", updateDisplayMode);
    };
  }, []);

  return isWebApp;
}
