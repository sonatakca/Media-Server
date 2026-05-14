import { motion, useReducedMotion } from "framer-motion";

interface TimedCarouselIndicatorsProps {
  count: number;
  activeIndex: number;
  durationMs: number;
  onSelect: (index: number) => void;
  isPaused?: boolean;
  className?: string;
  progressResetKey?: string | number;
  ariaLabel?: string;
}

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function TimedCarouselIndicators({
  count,
  activeIndex,
  durationMs,
  onSelect,
  isPaused = false,
  className,
  progressResetKey,
  ariaLabel = "Carousel navigation",
}: TimedCarouselIndicatorsProps) {
  const shouldReduceMotion = Boolean(useReducedMotion());
  // The carousel owner controls autoplay timing; paused/reduced-motion states use a settled fill instead of tracking fractional progress here.
  const showSettledProgress = isPaused || shouldReduceMotion;

  if (count <= 1) {
    return null;
  }

  const safeActiveIndex = Math.min(Math.max(activeIndex, 0), count - 1);
  const progressKey = `${safeActiveIndex}-${progressResetKey ?? "default"}-${isPaused ? "paused" : "playing"}`;

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={classNames(
        "flex max-w-full items-center justify-center gap-2 overflow-x-auto overscroll-x-contain rounded-full border border-white/[0.12] bg-black/[0.32] px-2.5 py-2 shadow-[0_18px_70px_rgba(0,0,0,0.34)] backdrop-blur-2xl",
        className,
      )}
    >
      {Array.from({ length: count }, (_, index) => {
        const isActive = index === safeActiveIndex;

        return (
          <motion.button
            key={index}
            layout
            type="button"
            aria-label={`Go to slide ${index + 1}`}
            aria-current={isActive ? "true" : undefined}
            className="group relative flex h-8 shrink-0 items-center justify-center rounded-full px-1 outline-none ring-white/70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            animate={{
              width: isActive ? 48 : 30,
              opacity: isActive ? 1 : 0.76,
            }}
            transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34, mass: 0.7 }}
            onClick={() => onSelect(index)}
          >
            <motion.span
              layout
              className={classNames(
                "relative block h-1.5 overflow-hidden rounded-full transition-colors duration-200 group-hover:bg-white/45",
                isActive ? "w-8 bg-white/25" : "w-1.5 bg-white/35",
              )}
              transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34, mass: 0.7 }}
            >
              {isActive ? (
                <motion.span
                  key={progressKey}
                  className="absolute inset-y-0 left-0 h-full w-full origin-left rounded-full bg-white shadow-[0_0_18px_rgba(255,255,255,0.42)]"
                  initial={{ scaleX: showSettledProgress ? 1 : 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{
                    duration: showSettledProgress ? 0 : durationMs / 1000,
                    ease: "linear",
                  }}
                />
              ) : null}
            </motion.span>
          </motion.button>
        );
      })}
    </div>
  );
}
