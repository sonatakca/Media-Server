import { useEffect, useState } from "react";

const MOBILE_VIEW_QUERY = "(max-width: 768px)";

function readIsMobileView(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) {
    return false;
  }

  return window.matchMedia(MOBILE_VIEW_QUERY).matches;
}

export function useIsMobileView(): boolean {
  const [isMobile, setIsMobile] = useState(readIsMobileView);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return undefined;
    }

    const mediaQuery = window.matchMedia(MOBILE_VIEW_QUERY);
    const updateIsMobile = () => {
      setIsMobile(mediaQuery.matches);
    };

    updateIsMobile();
    mediaQuery.addEventListener("change", updateIsMobile);

    return () => {
      mediaQuery.removeEventListener("change", updateIsMobile);
    };
  }, []);

  return isMobile;
}
