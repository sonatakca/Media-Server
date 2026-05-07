import { ReactNode, useLayoutEffect, useRef, useState } from "react";

type AnimatedWidthProps = {
  children: ReactNode;
  value: string;
  className?: string;
};

export function AnimatedWidth({ children, value, className = "" }: AnimatedWidthProps) {
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (!measureRef.current) return;

    const nextWidth = Math.ceil(measureRef.current.getBoundingClientRect().width);
    setWidth(nextWidth);
  }, [value]);

  return (
    <span
      className={`relative inline-block overflow-hidden align-middle transition-[width] duration-300 ease-out ${className}`}
      style={width ? { width } : undefined}
    >
      <span className="inline-flex items-center justify-center">{children}</span>

      <span
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
      >
        {value}
      </span>
    </span>
  );
}