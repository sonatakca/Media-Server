import { AnimatePresence, motion } from "framer-motion";
import { ChevronsRight } from "lucide-react";
import type { NormalizedMediaSegment } from "../../lib/types";

interface SkipSegmentButtonProps {
  segment: NormalizedMediaSegment | null;
  label: string;
  shouldReduceMotion: boolean;
  onSkip: (segment: NormalizedMediaSegment) => void;
  onControlsHoverStart?: () => void;
  onControlsHoverEnd?: () => void;
}

export function SkipSegmentButton({
  segment,
  label,
  shouldReduceMotion,
  onSkip,
  onControlsHoverStart,
  onControlsHoverEnd,
}: SkipSegmentButtonProps) {
  return (
    <AnimatePresence initial={false}>
      {segment ? (
        <motion.div
          key={segment.id}
          className="pointer-events-auto absolute bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+5.6rem)] right-[max(0.85rem,env(safe-area-inset-right))] z-[38] sm:bottom-[calc(max(1.25rem,env(safe-area-inset-bottom))+7.2rem)] sm:right-[max(1.25rem,env(safe-area-inset-right))]"
          initial={
            shouldReduceMotion
              ? { opacity: 0 }
              : { opacity: 0, y: 14, scale: 0.98 }
          }
          animate={
            shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }
          }
          exit={
            shouldReduceMotion
              ? { opacity: 0 }
              : { opacity: 0, y: 8, scale: 0.98 }
          }
          transition={
            shouldReduceMotion
              ? { duration: 0.01 }
              : {
                  duration: 0.22,
                  ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
                }
          }
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSkip(segment);
            }}
            onMouseEnter={onControlsHoverStart}
            onMouseLeave={onControlsHoverEnd}
            onPointerEnter={onControlsHoverStart}
            onPointerLeave={onControlsHoverEnd}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/15 bg-black/70 px-4 py-2 text-sm font-black text-white shadow-button-glow backdrop-blur-xl transition duration-200 hover:-translate-y-0.5 hover:border-[var(--accent)]/70 hover:bg-[var(--accent)] hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black active:scale-[0.98] motion-reduce:hover:translate-y-0 sm:min-h-12 sm:px-5 sm:text-base"
            aria-label={label}
          >
            <ChevronsRight className="h-5 w-5 shrink-0" strokeWidth={2.5} />
            <span className="whitespace-nowrap">{label}</span>
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
