import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "framer-motion";

interface SlidingIndicatorProps {
  /** The positioned element the indicator lives in and measures against. */
  containerRef: RefObject<HTMLElement>;
  /** Selects the element the indicator should sit on, inside the container. */
  activeSelector: string;
  /** Changes whenever the active element may have changed. */
  measureKey: unknown;
  className?: string;
  children?: ReactNode;
}

// A tween, not a spring: it lands exactly on time instead of creeping the
// last few pixels, and a retarget mid-flight simply sets off from where it is.
const glide = { duration: 0.38, ease: [0.22, 1, 0.36, 1] } as const;

/**
 * One indicator that travels from the old active element to the new one,
 * rather than one that vanishes here and reappears there.
 *
 * Positions come from offsetLeft/offsetTop, which ignore transforms and page
 * scroll, so a fixed navbar and a scrolled list measure the same way. Size
 * changes of the active element (a label swapping language, a tab growing) are
 * followed through a ResizeObserver; the spring retargets without a jolt.
 */
export function SlidingIndicator({
  containerRef,
  activeSelector,
  measureKey,
  className = "",
  children,
}: SlidingIndicatorProps) {
  const shouldReduceMotion = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const width = useMotionValue(0);
  const height = useMotionValue(0);
  const opacity = useMotionValue(0);
  const hasPlacedRef = useRef(false);

  const place = useCallback(
    (instant: boolean) => {
      const container = containerRef.current;
      const target = container?.querySelector<HTMLElement>(activeSelector);

      if (!container || !target) {
        animate(opacity, 0, { duration: 0.18 });
        hasPlacedRef.current = false;
        return;
      }

      // offsetLeft is relative to the offsetParent; walk up to the container
      // so a target nested inside a list item still measures correctly.
      let left = 0;
      let top = 0;
      let node: HTMLElement | null = target;
      while (node && node !== container) {
        left += node.offsetLeft;
        top += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
      }

      const next = {
        x: left,
        y: top,
        width: target.offsetWidth,
        height: target.offsetHeight,
      };
      const snap = instant || !hasPlacedRef.current || shouldReduceMotion;

      if (snap) {
        x.set(next.x);
        y.set(next.y);
        width.set(next.width);
        height.set(next.height);
      } else {
        animate(x, next.x, glide);
        animate(y, next.y, glide);
        animate(width, next.width, glide);
        animate(height, next.height, glide);
      }

      animate(opacity, 1, { duration: hasPlacedRef.current ? 0.12 : 0.22 });
      hasPlacedRef.current = true;
    },
    [
      activeSelector,
      containerRef,
      height,
      opacity,
      shouldReduceMotion,
      width,
      x,
      y,
    ],
  );

  useLayoutEffect(() => {
    place(false);
  }, [measureKey, place]);

  useLayoutEffect(() => {
    const container = containerRef.current;

    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    // Follows the active element while it resizes; a resize is a correction,
    // not a journey, so it glides only if the indicator is already placed.
    const observer = new ResizeObserver(() => place(false));
    observer.observe(container);
    for (const child of Array.from(container.children)) {
      observer.observe(child);
    }

    return () => observer.disconnect();
  }, [containerRef, place]);

  return (
    <motion.span
      aria-hidden="true"
      className={`pointer-events-none absolute left-0 top-0 ${className}`}
      style={{ x, y, width, height, opacity }}
    >
      {children}
    </motion.span>
  );
}
