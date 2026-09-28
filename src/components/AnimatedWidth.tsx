import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

type AnimatedWidthProps = {
  children: ReactNode;
  value: string;
  className?: string;
  safetyPx?: number;
};

export function AnimatedWidth({
  children,
  value,
  className = "",
  safetyPx = 4,
}: AnimatedWidthProps) {
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const prefersReducedMotion = usePrefersReducedMotion();

  useLayoutEffect(() => {
    if (prefersReducedMotion) {
      setWidth(undefined);
      return;
    }

    const node = measureRef.current;
    if (!node) return;

    const measure = () =>
      setWidth(Math.ceil(node.getBoundingClientRect().width) + safetyPx);
    measure();

    // The measured copy also changes size when `value` has not: the web font
    // swapping in over its fallback, or a breakpoint stepping the font size.
    // A width taken only on `value` stays pinned to the first of those and
    // clips the text for good.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [prefersReducedMotion, value, safetyPx]);

  return (
    <span
      className={`relative inline-block overflow-hidden align-middle ${
        prefersReducedMotion ? "" : "transition-[width] duration-300 ease-out"
      } ${className}`}
      style={width ? { width } : undefined}
    >
      <span className="inline-flex items-center justify-center">
        {children}
      </span>

      <span
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 inline-block whitespace-nowrap"
      >
        {value}
      </span>
    </span>
  );
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);

    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);

    return () => {
      mediaQuery.removeEventListener("change", updatePreference);
    };
  }, []);

  return prefersReducedMotion;
}
