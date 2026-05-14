import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Pause, Play } from "lucide-react";

interface TimedCarouselIndicatorsProps {
  count: number;
  activeIndex: number;
  durationMs: number;
  onSelect: (index: number) => void;
  isPaused?: boolean;
  className?: string;
  progressResetKey?: string | number;
  ariaLabel?: string;
  onTogglePaused?: () => void;
  showPauseButton?: boolean;
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
  onTogglePaused,
  showPauseButton = false,
}: TimedCarouselIndicatorsProps) {
  const shouldReduceMotion = Boolean(useReducedMotion());
  // The carousel owner controls autoplay timing; paused/reduced-motion states use a settled fill instead of tracking fractional progress here.
  const showSettledProgress = isPaused || shouldReduceMotion;

  if (count <= 1) {
    return null;
  }

  const safeActiveIndex = Math.min(Math.max(activeIndex, 0), count - 1);
  const progressKey = `${safeActiveIndex}-${progressResetKey ?? "default"}-${isPaused ? "paused" : "playing"}`;
  const springTransition = shouldReduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 430, damping: 34, mass: 0.75 };
  const softSpringTransition = shouldReduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 360, damping: 32, mass: 0.78 };

  return (
    <motion.div
      role="group"
      aria-label={ariaLabel}
      className={classNames(
        "flex max-w-full items-center",
        className,
      )}
    >
      <motion.div
        layout
        className="media-scroll relative flex h-10 max-w-full origin-center items-center gap-2.5 overflow-x-auto overscroll-x-contain rounded-full border border-white/[0.10] bg-white/[0.14] px-3.5 shadow-[0_18px_60px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-2xl sm:h-11 sm:px-4"
        initial={
          shouldReduceMotion
            ? { opacity: 1 }
            : {
                opacity: 0,
                scale: 0.72,
                scaleX: 0.18,
                y: 12,
                filter: "blur(8px)",
              }
        }
        animate={{ opacity: 1, scale: 1, scaleX: 1, y: 0, filter: "blur(0px)" }}
        transition={springTransition}
      >
        {Array.from({ length: count }, (_, index) => {
          const isActive = index === safeActiveIndex;
          const revealDelay = shouldReduceMotion ? 0 : 0.16 + index * 0.028;

          return (
            <motion.button
              key={index}
              layout
              type="button"
              aria-label={`Go to slide ${index + 1}`}
              aria-current={isActive ? "true" : undefined}
              className="group relative flex h-7 shrink-0 items-center justify-center rounded-full px-1 outline-none ring-white/70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.65 }}
              animate={{
                width: isActive ? 48 : 24,
                opacity: isActive ? 1 : 0.82,
                scale: 1,
              }}
              transition={{
                width: softSpringTransition,
                opacity: {
                  duration: shouldReduceMotion ? 0 : 0.22,
                  ease: [0.16, 1, 0.3, 1],
                  delay: revealDelay,
                },
                scale: {
                  ...softSpringTransition,
                  delay: revealDelay,
                },
              }}
              onClick={() => onSelect(index)}
            >
              <motion.span
                layout
                className={classNames(
                  "relative block h-[7px] overflow-hidden rounded-full transition-colors duration-200 group-hover:bg-white/[0.55]",
                  isActive ? "w-10 bg-white/[0.28]" : "w-[7px] bg-white/[0.44]",
                )}
                transition={softSpringTransition}
              >
                {isActive ? (
                  <motion.span
                    key={progressKey}
                    className="absolute inset-y-0 left-0 h-full w-full origin-left rounded-full bg-white/[0.92]"
                    initial={{ scaleX: showSettledProgress ? 1 : 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{
                      duration: showSettledProgress ? 0 : Math.max(0, durationMs / 1000),
                      ease: "linear",
                    }}
                  />
                ) : null}
              </motion.span>
            </motion.button>
          );
        })}
      </motion.div>

      {showPauseButton ? (
        <motion.button
          type="button"
          aria-label={isPaused ? "Resume carousel" : "Pause carousel"}
          className="ml-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/[0.10] bg-white/[0.14] text-white/[0.92] shadow-[0_18px_60px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.12)] outline-none backdrop-blur-2xl transition-colors hover:bg-white/[0.20] hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:h-11 sm:w-11"
          initial={
            shouldReduceMotion
              ? { opacity: 1 }
              : {
                  opacity: 0,
                  scale: 0.75,
                  x: -8,
                  filter: "blur(8px)",
                }
          }
          animate={{ opacity: 1, scale: 1, x: 0, filter: "blur(0px)" }}
          transition={{
            ...softSpringTransition,
            delay: shouldReduceMotion ? 0 : 0.18,
          }}
          onClick={onTogglePaused}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={isPaused ? "play" : "pause"}
              className="flex items-center justify-center"
              initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, scale: 0.75, rotate: -4 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.75, rotate: 4 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              {isPaused ? (
                <Play className="ml-0.5 h-[18px] w-[18px]" fill="currentColor" strokeWidth={2.5} />
              ) : (
                <Pause className="h-[18px] w-[18px]" fill="currentColor" strokeWidth={2.5} />
              )}
            </motion.span>
          </AnimatePresence>
        </motion.button>
      ) : null}
    </motion.div>
  );
}
