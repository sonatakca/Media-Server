import { createPortal } from "react-dom";
import { BackButton } from "../BackButton";

/**
 * Where the back button stands over the phone's title hero (a phone, or a
 * tablet upright): on the picture's top-left, in line with the title and
 * copy (`left-4`), a rem under the navbar, and pinned there as the page
 * scrolls.
 *
 * It is drawn into `document.body` because the page sits inside a
 * transformed ancestor, and a transform makes `position: fixed` relative to
 * itself: in place, the button stood 26-44px off the copy's edge and
 * scrolled away with the page.
 */
export const HERO_BACK_POSITION =
  "fixed left-4 top-[calc(4.5rem+env(safe-area-inset-top))] z-[80]";

export function HeroBackButton({ fallbackTo }: { fallbackTo: string }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <BackButton
      fallbackTo={fallbackTo}
      label=""
      variant="hero"
      noYShift
      className={HERO_BACK_POSITION}
    />,
    document.body,
  );
}

/** The button's place while the page loads, the same size and spot. */
export function HeroBackButtonPlaceholder() {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={HERO_BACK_POSITION}>
      <div className="shimmer h-12 w-12 rounded-full" />
    </div>,
    document.body,
  );
}
