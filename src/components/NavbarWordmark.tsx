import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useReducedMotion } from "framer-motion";
import warmRed from "../assets/navbar-wordmark/warm-red.webp";
import amber from "../assets/navbar-wordmark/amber.webp";
import gold from "../assets/navbar-wordmark/gold.webp";
import olive from "../assets/navbar-wordmark/olive.webp";
import green from "../assets/navbar-wordmark/green.webp";
import teal from "../assets/navbar-wordmark/teal.webp";
import {
  isLoadingActivityPending,
  subscribeLoadingActivity,
} from "../lib/loadingActivity";

// Palette order, which is also the cycle order. Names match ACCENT_THEMES.
const FRAMES = [
  { accent: "Warm Red", src: warmRed },
  { accent: "Amber", src: amber },
  { accent: "Gold", src: gold },
  { accent: "Olive", src: olive },
  { accent: "Green", src: green },
  { accent: "Teal", src: teal },
];

// One full lap in half a second, the pace of the brand loading animation.
export const WORDMARK_FRAME_MS = 500 / FRAMES.length;

// How long the cycle keeps going after loading has finished.
export const WORDMARK_LOADING_TAIL_MS = 2500;

function subscribeAccentTheme(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-accent-theme"],
  });
  return () => observer.disconnect();
}

function getAccentThemeName(): string | undefined {
  return document.documentElement.dataset.accentTheme;
}

/**
 * A soft dark shadow, wherever the wordmark stands: over a hero the room
 * behind it is lit by the artwork's colours, which can be the accent's own.
 */
const WORDMARK_SHADOW =
  "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6)) drop-shadow(0 3px 14px rgba(0, 0, 0, 0.5))";

/**
 * The wordmark in the current accent colour. While anything is loading it
 * cycles through the palette, and keeps cycling for a further 2.5 seconds
 * once loading ends. Then it carries on until it comes round to the accent
 * colour again, so it never stops on a stranger's colour and never jumps.
 */
export function NavbarWordmark({ className = "" }: { className?: string }) {
  const accentName = useSyncExternalStore(
    subscribeAccentTheme,
    getAccentThemeName,
    () => undefined,
  );
  const isLoading = useSyncExternalStore(
    subscribeLoadingActivity,
    isLoadingActivityPending,
    () => false,
  );
  const reduceMotion = useReducedMotion() ?? false;
  const accentIndex = Math.max(
    0,
    FRAMES.findIndex((frame) => frame.accent === accentName),
  );

  // Null while resting on the accent colour.
  const [cycleIndex, setCycleIndex] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const shownRef = useRef(accentIndex);
  const latestRef = useRef({ accentIndex, isLoading, reduceMotion });
  useEffect(() => {
    latestRef.current = { accentIndex, isLoading, reduceMotion };
  });
  // When the most recent load finished; null while one is in progress.
  const loadEndedAtRef = useRef<number | null>(null);
  useEffect(() => {
    loadEndedAtRef.current = isLoading ? null : Date.now();
  }, [isLoading]);

  useEffect(() => {
    if (!isLoading || reduceMotion || timerRef.current !== null) return;

    shownRef.current = latestRef.current.accentIndex;
    timerRef.current = window.setInterval(() => {
      const latest = latestRef.current;
      const loadEndedAt = loadEndedAtRef.current;
      const inTail =
        loadEndedAt !== null &&
        Date.now() - loadEndedAt < WORDMARK_LOADING_TAIL_MS;
      const settled =
        !latest.isLoading && !inTail && shownRef.current === latest.accentIndex;

      if (settled || latest.reduceMotion) {
        window.clearInterval(timerRef.current ?? undefined);
        timerRef.current = null;
        setCycleIndex(null);
        return;
      }

      shownRef.current = (shownRef.current + 1) % FRAMES.length;
      setCycleIndex(shownRef.current);
    }, WORDMARK_FRAME_MS);
  }, [isLoading, reduceMotion]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    },
    [],
  );

  const shownIndex = cycleIndex ?? accentIndex;

  return (
    <span
      data-wordmark-accent={FRAMES[shownIndex].accent}
      className={`relative block aspect-[430/176] ${className}`}
      style={{ filter: WORDMARK_SHADOW }}
    >
      {FRAMES.map((frame, index) => (
        // Every frame stays mounted so a colour change never waits on a decode.
        <img
          key={frame.accent}
          src={frame.src}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          className="absolute inset-0 h-full w-full object-contain"
          style={{ opacity: index === shownIndex ? 1 : 0 }}
        />
      ))}
    </span>
  );
}
