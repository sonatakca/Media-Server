import { useEffect, useRef, useState } from "react";

type AnimatedTextProps = {
  value: string;
  className?: string;
};

type TextLayer = {
  id: number;
  text: string;
  phase: "enter" | "idle" | "exit";
};

export function AnimatedText({ value, className = "" }: AnimatedTextProps) {
  const nextIdRef = useRef(1);
  const prefersReducedMotion = usePrefersReducedMotion();

  const [layers, setLayers] = useState<TextLayer[]>([
    {
      id: 0,
      text: value,
      phase: "idle",
    },
  ]);

  useEffect(() => {
    if (prefersReducedMotion) {
      setLayers([{ id: nextIdRef.current++, text: value, phase: "idle" }]);
      return undefined;
    }

    const currentLayer = layers[layers.length - 1];

    if (currentLayer?.text === value) {
      return undefined;
    }

    const newLayerId = nextIdRef.current++;

    setLayers((current) => [
      ...current.map((layer) => ({
        ...layer,
        phase: "exit" as const,
      })),
      {
        id: newLayerId,
        text: value,
        phase: "enter",
      },
    ]);

    const enterFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setLayers((current) =>
          current.map((layer) =>
            layer.id === newLayerId
              ? {
                  ...layer,
                  phase: "idle",
                }
              : layer,
          ),
        );
      });
    });

    const cleanupTimeout = window.setTimeout(() => {
      setLayers((current) =>
        current.filter((layer) => layer.id === newLayerId),
      );
    }, 520);

    return () => {
      window.cancelAnimationFrame(enterFrame);
      window.clearTimeout(cleanupTimeout);
    };
    // Only react to incoming text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReducedMotion, value]);

  if (prefersReducedMotion) {
    return <span className={className}>{value}</span>;
  }

  const shouldAnimateLetters = layers.length > 1 || layers[0]?.phase !== "idle";

  if (!shouldAnimateLetters) {
    return (
      <span
        className={`inline-block whitespace-nowrap align-middle ${className}`}
      >
        {value}
      </span>
    );
  }

  return (
    <span
      className={`relative inline-grid overflow-hidden whitespace-nowrap align-middle ${className}`}
      aria-label={value}
    >
      {layers.map((layer) => (
        <span
          key={layer.id}
          aria-hidden="true"
          className="col-start-1 row-start-1 inline-flex whitespace-nowrap"
        >
          {splitText(layer.text).map((letter, index) => (
            <span
              key={`${layer.id}-${index}-${letter}`}
              className="inline-block transition-[opacity,transform] duration-300 ease-out"
              style={{
                transitionDelay: `${index * 22}ms`,
                transform:
                  layer.phase === "enter"
                    ? "translateY(-0.75em)"
                    : layer.phase === "exit"
                      ? "translateY(0.75em)"
                      : "translateY(0)",
                opacity: layer.phase === "idle" ? 1 : 0,
              }}
            >
              {letter === " " ? "\u00A0" : letter}
            </span>
          ))}
        </span>
      ))}
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
