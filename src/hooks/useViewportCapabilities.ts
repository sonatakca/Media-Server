import { useEffect, useState } from "react";
import { readViewportCapabilities, type ViewportCapabilities } from "../lib/device";

export function useViewportCapabilities(): ViewportCapabilities {
  const [capabilities, setCapabilities] = useState<ViewportCapabilities>(() => readViewportCapabilities());

  useEffect(() => {
    const updateCapabilities = () => {
      setCapabilities(readViewportCapabilities());
    };

    const coarsePointerQuery = window.matchMedia("(pointer: coarse)");
    const portraitQuery = window.matchMedia("(orientation: portrait)");

    updateCapabilities();
    window.addEventListener("resize", updateCapabilities);
    window.addEventListener("orientationchange", updateCapabilities);
    window.visualViewport?.addEventListener("resize", updateCapabilities);
    coarsePointerQuery.addEventListener("change", updateCapabilities);
    portraitQuery.addEventListener("change", updateCapabilities);

    return () => {
      window.removeEventListener("resize", updateCapabilities);
      window.removeEventListener("orientationchange", updateCapabilities);
      window.visualViewport?.removeEventListener("resize", updateCapabilities);
      coarsePointerQuery.removeEventListener("change", updateCapabilities);
      portraitQuery.removeEventListener("change", updateCapabilities);
    };
  }, []);

  return capabilities;
}
