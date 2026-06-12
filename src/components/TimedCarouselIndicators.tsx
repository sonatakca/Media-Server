import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Pause, Play } from "lucide-react";

interface TimedCarouselIndicatorsProps {
  count: number;
  activeIndex: number;
  durationMs: number;
  progressStartedAtMs?: number;
  onSelect: (index: number) => void;
  isPaused?: boolean;
  className?: string;
  progressResetKey?: string | number;
  ariaLabel?: string;
  onTogglePaused?: () => void;
  showPauseButton?: boolean;
  isPauseButtonDisabled?: boolean;
  maxVisibleDots?: number;
}

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

function AnimatedCarouselNumber({
  value,
  digitCount,
}: {
  value: number;
  digitCount: number;
}) {
  const digits = String(value).padStart(digitCount, "0").split("");

  return (
    <span
      className="flex h-[1em] items-center overflow-hidden tabular-nums leading-none"
      aria-label={String(value)}
    >
      {digits.map((digit, index) => (
        <span
          key={index}
          className="relative block h-[1em] w-[0.65em] overflow-hidden" // Widened to 0.65em
          aria-hidden="true"
        >
          <motion.span
            className="absolute left-0 top-0 flex flex-col"
            initial={false}
            animate={{
              y: `-${Number(digit)}em`,
            }}
            transition={{
              type: "spring",
              stiffness: 520,
              damping: 42,
              mass: 0.7,
            }}
          >
            {Array.from({ length: 10 }, (_, number) => (
              <span
                key={number}
                className="flex h-[1em] w-[0.65em] items-center justify-center" // Widened to 0.65em
              >
                {number}
              </span>
            ))}
          </motion.span>
        </span>
      ))}
    </span>
  );
}

const INITIAL_DOT_REVEAL_MS = 1300;

export function TimedCarouselIndicators({
  count,
  activeIndex,
  durationMs,
  progressStartedAtMs,
  onSelect,
  isPaused = false,
  className,
  progressResetKey,
  ariaLabel = "Carousel navigation",
  onTogglePaused,
  showPauseButton = false,
  isPauseButtonDisabled = false,
  maxVisibleDots,
}: TimedCarouselIndicatorsProps) {
  const shouldReduceMotion = Boolean(useReducedMotion());
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const [hasCompletedInitialReveal, setHasCompletedInitialReveal] =
    useState(false);
  const boundedCount = Math.max(count, 1);
  const safeActiveIndex = Math.min(Math.max(activeIndex, 0), boundedCount - 1);
  const previousActiveIndexRef = useRef(safeActiveIndex);
  const revealDirectionRef = useRef<1 | -1>(1);
  const counterDigitCount = String(count).length;
  const progressAnimationOffsetRef = useRef<{
    key: string;
    elapsedMs: number;
  } | null>(null);
  // The carousel owner controls autoplay timing; paused/reduced-motion states use a settled fill instead of tracking fractional progress here.
  const showSettledProgress = isPaused || shouldReduceMotion;

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 640px)");
    const updateCompactViewport = () =>
      setIsCompactViewport(mediaQuery.matches);

    updateCompactViewport();
    mediaQuery.addEventListener("change", updateCompactViewport);

    return () => {
      mediaQuery.removeEventListener("change", updateCompactViewport);
    };
  }, []);

  useEffect(() => {
    if (count <= 1 || shouldReduceMotion) {
      setHasCompletedInitialReveal(true);
      return;
    }

    setHasCompletedInitialReveal(false);

    const timeoutId = window.setTimeout(() => {
      setHasCompletedInitialReveal(true);
    }, INITIAL_DOT_REVEAL_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [count, shouldReduceMotion]);

  if (count <= 1) {
    return null;
  }

  if (previousActiveIndexRef.current !== safeActiveIndex) {
    let delta = safeActiveIndex - previousActiveIndexRef.current;
    const halfCount = count / 2;

    if (delta > halfCount) {
      delta -= count;
    } else if (delta < -halfCount) {
      delta += count;
    }

    revealDirectionRef.current = delta < 0 ? -1 : 1;
    previousActiveIndexRef.current = safeActiveIndex;
  }

  const normalizedMaxVisibleDots =
    typeof maxVisibleDots === "number" && maxVisibleDots > 0
      ? Math.max(1, Math.floor(maxVisibleDots))
      : null;
  const visibleDotLimit = normalizedMaxVisibleDots
    ? normalizedMaxVisibleDots % 2 === 0
      ? Math.max(1, normalizedMaxVisibleDots - 1)
      : normalizedMaxVisibleDots
    : count;
  const shouldWindowDots =
    normalizedMaxVisibleDots !== null && count > visibleDotLimit;
  const visibleDotCount = shouldWindowDots ? visibleDotLimit : count;
  const visibleDotCenter = Math.floor(visibleDotCount / 2);
  const visibleIndicators = Array.from(
    { length: visibleDotCount },
    (_, position) => {
      const offset = shouldWindowDots ? position - visibleDotCenter : 0;
      const index = shouldWindowDots
        ? (safeActiveIndex + offset + count) % count
        : position;

      return {
        index,
        position,
        distanceFromActive: shouldWindowDots
          ? Math.abs(offset)
          : Math.abs(position - safeActiveIndex),
      };
    },
  );
  const progressKey = `${safeActiveIndex}-${progressResetKey ?? "default"}`;
  const normalizedDurationMs = Math.max(durationMs, 0);
  const progressAnimationKey = `${progressKey}-${progressStartedAtMs ?? "none"}-${normalizedDurationMs}`;

  if (progressAnimationOffsetRef.current?.key !== progressAnimationKey) {
    progressAnimationOffsetRef.current = {
      key: progressAnimationKey,
      elapsedMs: Math.min(
        Math.max(progressStartedAtMs ? Date.now() - progressStartedAtMs : 0, 0),
        normalizedDurationMs,
      ),
    };
  }

  const elapsedProgressMs = progressAnimationOffsetRef.current.elapsedMs;
  const progressFillRevealDelaySeconds =
    elapsedProgressMs > INITIAL_DOT_REVEAL_MS ? 0 : 0.85;
  const springTransition = shouldReduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 430, damping: 34, mass: 0.75 };
  const softSpringTransition = shouldReduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 360, damping: 32, mass: 0.78 };
  const activeButtonWidth = isCompactViewport ? 34 : 48;
  const inactiveButtonWidth = isCompactViewport ? 17 : 24;
  const activeDotWidth = isCompactViewport ? 32 : 40;
  const baseInactiveDotSize = isCompactViewport ? 6 : 7;
  const windowedContainerWidth = isCompactViewport ? 200 : 286;

  return (
    <motion.div
      role="group"
      aria-label={ariaLabel}
      className={classNames("flex max-w-full items-center", className)}
    >
      <motion.div
        layout
        className="mr-2 flex h-9 min-w-12 shrink-0 items-center justify-center rounded-full border border-white/[0.10] bg-white/[0.14] px-3 text-[0.72rem] font-black tabular-nums text-white/90 shadow-[0_18px_60px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.12)] sm:mr-3 sm:h-11 sm:min-w-14 sm:text-sm"
        initial={
          shouldReduceMotion
            ? { opacity: 1 }
            : {
                opacity: 0,
                scale: 0.75,
                x: 10,
                y: 4,
              }
        }
        animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
        transition={{
          ...softSpringTransition,
          delay: shouldReduceMotion ? 0 : 0.55,
        }}
        aria-hidden="true"
      >
        <AnimatedCarouselNumber
          value={safeActiveIndex + 1}
          digitCount={counterDigitCount}
        />
      </motion.div>

      <motion.div
        layout
        style={
          shouldWindowDots
            ? {
                width: windowedContainerWidth,
                minWidth: windowedContainerWidth,
                maxWidth: windowedContainerWidth,
              }
            : undefined
        }
        className={classNames(
          "relative flex h-9 max-w-full origin-center items-center gap-1.5 rounded-full border border-white/[0.10] bg-white/[0.14] px-2.5 shadow-[0_18px_60px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.12)] sm:h-11 sm:gap-2.5 sm:px-4",
          shouldWindowDots
            ? "overflow-hidden"
            : "media-scroll overflow-x-auto overscroll-x-contain",
        )}
        initial={
          shouldReduceMotion
            ? { opacity: 1 }
            : {
                opacity: 0,
                scale: 0.72,
                scaleX: 0.18,
                y: 12,
              }
        }
        animate={{ opacity: 1, scale: 1, scaleX: 1, y: 0 }}
        transition={{
          ...springTransition,
          delay: shouldReduceMotion ? 0 : 0.35,
        }}
      >
        {visibleIndicators.map(({ index, position, distanceFromActive }) => {
          const isActive = index === safeActiveIndex;
          const shiftedRevealPosition =
            revealDirectionRef.current < 0
              ? visibleDotCount - 1 - position
              : position;
          const revealDelay = shouldReduceMotion
            ? 0
            : shouldWindowDots && hasCompletedInitialReveal
              ? 0.12 + shiftedRevealPosition * 0.05
              : 0.65 + position * 0.045;
          const taperedDotSize = shouldWindowDots
            ? Math.max(3, baseInactiveDotSize - distanceFromActive)
            : baseInactiveDotSize;
          const buttonWidth = isActive
            ? activeButtonWidth
            : shouldWindowDots
              ? Math.max(11, taperedDotSize + (isCompactViewport ? 8 : 11))
              : inactiveButtonWidth;
          const buttonOpacity = isActive
            ? 1
            : shouldWindowDots
              ? Math.max(0.34, 0.88 - distanceFromActive * 0.13)
              : 0.82;
          const initialSlideX =
            shouldWindowDots &&
            hasCompletedInitialReveal &&
            revealDirectionRef.current < 0
              ? 10
              : -10;

          return (
            <motion.button
              key={index}
              layout
              type="button"
              aria-label={`Go to slide ${index + 1}`}
              aria-current={isActive ? "true" : undefined}
              className="group relative flex h-6 shrink-0 items-center justify-center rounded-full px-0.5 outline-none ring-white/70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:h-7 sm:px-1"
              initial={
                shouldReduceMotion
                  ? false
                  : {
                      opacity: 0,
                      scale: 0.62,
                      x: initialSlideX,
                      y: 4,
                      filter: "blur(30px)",
                    }
              }
              animate={{
                width: buttonWidth,
                opacity: buttonOpacity,
                scale: 1,
                x: 0,
                y: 0,
                filter: "blur(0px)",
              }}
              transition={{
                width: softSpringTransition,
                opacity: {
                  duration: shouldReduceMotion ? 0 : 0.18,
                  ease: [0.16, 1, 0.3, 1],
                },
                scale: {
                  ...softSpringTransition,
                  delay: shouldReduceMotion ? 0 : revealDelay,
                },
                x: {
                  ...softSpringTransition,
                  delay: shouldReduceMotion ? 0 : revealDelay,
                },
                y: {
                  ...softSpringTransition,
                  delay: shouldReduceMotion ? 0 : revealDelay,
                },
                filter: {
                  duration: shouldReduceMotion ? 0 : 0.38,
                  ease: [0.16, 1, 0.3, 1],
                  delay: shouldReduceMotion ? 0 : revealDelay,
                },
              }}
              onClick={() => {
                if (isActive) {
                  return;
                }

                onSelect(index);
              }}
            >
              <motion.span
                layout
                className={classNames(
                  "relative block overflow-hidden rounded-full transition-colors duration-200",
                  isActive
                    ? "bg-white/[0.28] group-hover:bg-white/[0.28]"
                    : "bg-white/[0.44] group-hover:bg-white/[1]",
                )}
                animate={{
                  width: isActive ? activeDotWidth : taperedDotSize,
                  height: isActive ? 7 : taperedDotSize,
                }}
                transition={softSpringTransition}
              >
                {isActive ? (
                  <motion.span
                    key={progressKey}
                    className="absolute inset-y-0 left-0 h-full w-full origin-left rounded-full bg-white/[0.92]"
                    initial={
                      shouldReduceMotion ? { opacity: 1 } : { opacity: 0 }
                    }
                    animate={{ opacity: 1 }}
                    transition={{
                      duration: shouldReduceMotion ? 0 : 0.35,
                      delay: shouldReduceMotion
                        ? 0
                        : progressFillRevealDelaySeconds,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                    style={{
                      transform: shouldReduceMotion ? "scaleX(1)" : undefined,
                      animation: shouldReduceMotion
                        ? undefined
                        : `carousel-progress-fill ${normalizedDurationMs}ms linear forwards`,
                      animationDelay: shouldReduceMotion
                        ? undefined
                        : `${-elapsedProgressMs}ms`,
                      animationPlayState: isPaused ? "paused" : "running",
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
          className={classNames(
            "ml-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/[0.10] bg-white/[0.14] text-white/[0.92] shadow-[0_18px_60px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.12)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:ml-3 sm:h-11 sm:w-11",
            isPauseButtonDisabled
              ? "cursor-not-allowed opacity-55"
              : "hover:bg-white/[0.20] hover:text-white",
          )}
          disabled={isPauseButtonDisabled}
          aria-disabled={isPauseButtonDisabled}
          initial={
            shouldReduceMotion
              ? { opacity: 1 }
              : {
                  opacity: 0,
                  scale: 0.75,
                  x: -10,
                  y: 4,
                }
          }
          animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
          transition={{
            ...softSpringTransition,
            delay: shouldReduceMotion
              ? 0
              : 0.65 + visibleIndicators.length * 0.045,
          }}
          onClick={isPauseButtonDisabled ? undefined : onTogglePaused}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={isPaused ? "play" : "pause"}
              className="flex items-center justify-center"
              initial={
                shouldReduceMotion
                  ? { opacity: 1 }
                  : { opacity: 1, scale: 0, rotate: -4 }
              }
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={
                shouldReduceMotion
                  ? { opacity: 1 }
                  : { opacity: 1, scale: 0, rotate: 4 }
              }
              transition={{
                duration: shouldReduceMotion ? 0 : 0.16,
                ease: [0.16, 1, 0.3, 1],
              }}
            >
              {isPaused ? (
                <Play
                  className="ml-0.5 h-[18px] w-[18px]"
                  fill="currentColor"
                  strokeWidth={2.5}
                />
              ) : (
                <Pause
                  className="h-[18px] w-[18px]"
                  fill="currentColor"
                  strokeWidth={2.5}
                />
              )}
            </motion.span>
          </AnimatePresence>
        </motion.button>
      ) : null}
    </motion.div>
  );
}
