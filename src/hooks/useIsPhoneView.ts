import { useEffect, useState } from "react";

/**
 * A phone held upright: narrower than the hero's tablet layout begins. The
 * phone keeps its own poster-card hero and title page; a tablet, and a phone
 * on its side, get the desktop's hero laid out for their stage.
 */
const PHONE_VIEW_QUERY = "(max-width: 599px)";

function readIsPhoneView(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(PHONE_VIEW_QUERY).matches;
}

export function useIsPhoneView(): boolean {
  const [isPhone, setIsPhone] = useState(readIsPhoneView);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mediaQuery = window.matchMedia(PHONE_VIEW_QUERY);
    const update = () => setIsPhone(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return isPhone;
}
