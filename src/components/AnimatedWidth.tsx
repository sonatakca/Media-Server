import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

type AnimatedWidthProps = {
  children: ReactNode;
  value: string;
  className?: string;
  safetyPx?: number;
};

export function AnimatedWidth({ children, value, className = "", safetyPx = 4 }: AnimatedWidthProps) {
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const prefersReducedMotion = usePrefersReducedMotion();

  useLayoutEffect(() => {
    if (prefersReducedMotion) {
      setWidth(undefined);
      return;
    }

    if (!measureRef.current) return;

    const nextWidth = Math.ceil(measureRef.current.getBoundingClientRect().width) + safetyPx;
    setWidth(nextWidth);
  }, [prefersReducedMotion, value, safetyPx]);

  return (
    <span
      className={`relative inline-block overflow-hidden align-middle ${
        prefersReducedMotion ? "" : "transition-[width] duration-300 ease-out"
      } ${className}`}
      style={width ? { width } : undefined}
    >
      <span className="inline-flex items-center justify-center">{children}</span>

      <span
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 inline-flex whitespace-nowrap"
      >
        {splitText(value).map((letter, index) => {
          const isSpace = letter === " ";

          return (
            <span
              key={`${index}-${letter}`}
              className="inline-block"
              style={{
                width: isSpace ? "0.35em" : undefined,
              }}
            >
              {isSpace ? "\u00A0" : letter}
            </span>
          );
        })}
      </span>
    </span>
  );
}

function splitText(text: string) {
  return Array.from(text);
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
