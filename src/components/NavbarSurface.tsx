import { useEffect, useRef } from "react";
import "./NavbarSurface.css";

interface NavbarSurfaceProps {
  /** Shown whatever the scroll (a phone page with no artwork under it). */
  forced?: boolean;
  variant: "desktop" | "mobile";
}

/** How far the page travels while the ceiling comes in, in CSS px. */
const SCROLL_RANGE = 64;

/**
 * What the bar stands on: the room's black falling from the top of the
 * screen, thinning to nothing a little below the bar, with no edge. Its own
 * layer under the links, never the header itself: a backdrop-filter there
 * would become the containing block of every fixed panel inside it.
 *
 * It follows the page, not a clock. `--nav-p` is how far the first 64px of
 * scroll has gone, so the ceiling is exactly as present as the page has
 * moved, in either direction, at the finger's speed. Each layer fades
 * itself: fading their parent would make it the blur's backdrop root, and
 * the blur would drop what it blurs for the length of the fade, then snap.
 */
export function NavbarSurface({ forced = false, variant }: NavbarSurfaceProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (forced) {
      node.style.setProperty("--nav-p", "1");
      return undefined;
    }

    let frame = 0;
    const write = () => {
      frame = 0;
      const progress = Math.min(Math.max(window.scrollY / SCROLL_RANGE, 0), 1);
      node.style.setProperty("--nav-p", progress.toFixed(3));
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(write);
    };

    write();
    window.addEventListener("scroll", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [forced]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="navbar-surface"
      data-variant={variant}
    >
      <span className="navbar-surface__veil" />
      <span className="navbar-surface__shade" />
    </div>
  );
}
