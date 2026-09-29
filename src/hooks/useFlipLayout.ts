import { useLayoutEffect, useRef, type RefObject } from "react";
import { useReducedMotion } from "framer-motion";

const FLIP_KEY_ATTRIBUTE = "data-flip-key";
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
/** Longer journeys are shortened to this, travelling the same direction. */
const MAX_TRAVEL_PX = 160;

interface Position {
  left: number;
  top: number;
}

function readPositions(container: HTMLElement): Map<string, Position> {
  const positions = new Map<string, Position>();

  for (const element of container.querySelectorAll<HTMLElement>(
    `[${FLIP_KEY_ATTRIBUTE}]`,
  )) {
    const key = element.getAttribute(FLIP_KEY_ATTRIBUTE);
    // offsetLeft/offsetTop ignore transforms, so a card still mid-entrance or
    // mid-glide measures where it will rest, not where it is painted.
    if (key) {
      positions.set(key, { left: element.offsetLeft, top: element.offsetTop });
    }
  }

  return positions;
}

/**
 * The container must be positioned (`relative`), so children's offsets are
 * measured against it.
 *
 * Glides grid children from where they were to where a reorder or filter put
 * them (FLIP, measured, never computed from the model's idea of the layout).
 *
 * `layoutKey` names the arrangement — typically the ordered ids. Positions are
 * recorded after every arrangement and refreshed whenever the container
 * resizes, so a window resize never plays as a reorder. Travel is additive
 * (`composite: "add"`), so it layers over whatever entrance transform a card
 * is already running. Journeys longer than a card are shortened to a short
 * arrival from the right direction: a card crossing six rows in 400ms would
 * jump further per frame than the eye can follow.
 */
export function useFlipLayout(
  containerRef: RefObject<HTMLElement>,
  layoutKey: string,
): void {
  const shouldReduceMotion = useReducedMotion();
  const positionsRef = useRef<Map<string, Position> | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previous = positionsRef.current;
    const next = readPositions(container);
    positionsRef.current = next;

    if (!previous || shouldReduceMotion) return;
    if (typeof Element.prototype.animate !== "function") return;

    const viewportTop = -container.getBoundingClientRect().top;
    const viewportBottom = viewportTop + window.innerHeight;

    for (const element of container.querySelectorAll<HTMLElement>(
      `[${FLIP_KEY_ATTRIBUTE}]`,
    )) {
      const key = element.getAttribute(FLIP_KEY_ATTRIBUTE);
      const from = key ? previous.get(key) : undefined;
      const to = key ? next.get(key) : undefined;
      if (!from || !to) continue;

      let dx = from.left - to.left;
      let dy = from.top - to.top;
      if (dx === 0 && dy === 0) continue;

      // Nothing to see: neither end of the journey is on screen.
      const height = element.offsetHeight;
      const onScreen = (top: number) =>
        top + height > viewportTop && top < viewportBottom;
      if (!onScreen(from.top) && !onScreen(to.top)) continue;

      const distance = Math.hypot(dx, dy);
      const isShortened = distance > MAX_TRAVEL_PX * 2.5;
      if (isShortened) {
        dx = (dx / distance) * MAX_TRAVEL_PX;
        dy = (dy / distance) * MAX_TRAVEL_PX;
      }

      const duration = Math.min(320 + Math.min(distance, 400) * 0.35, 460);

      element.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0px, 0px)" },
        ],
        { duration, easing: EASE_OUT, composite: "add" },
      );

      // Opacity cannot be additive (1 + 0 is still 1), so the arrival of a
      // shortened journey fades on its own, replacing rather than adding.
      if (isShortened) {
        element.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: duration * 0.8,
          easing: EASE_OUT,
        });
      }
    }
  }, [containerRef, layoutKey, shouldReduceMotion]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      positionsRef.current = readPositions(container);
    });
    observer.observe(container);

    return () => observer.disconnect();
    // Re-attached per arrangement: the grid itself may mount only once there
    // is something to show.
  }, [containerRef, layoutKey]);
}
