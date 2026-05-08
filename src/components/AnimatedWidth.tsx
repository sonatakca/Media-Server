import { ReactNode, useLayoutEffect, useRef, useState } from "react";

type AnimatedWidthProps = {
  children: ReactNode;
  value: string;
  className?: string;
  safetyPx?: number;
};

export function AnimatedWidth({ children, value, className = "", safetyPx = 4 }: AnimatedWidthProps) {
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (!measureRef.current) return;

    const nextWidth = Math.ceil(measureRef.current.getBoundingClientRect().width) + safetyPx;
    setWidth(nextWidth);
  }, [value, safetyPx]);

  return (
    <span
      className={`relative inline-block overflow-hidden align-middle transition-[width] duration-300 ease-out ${className}`}
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