import { motion, useReducedMotion } from "framer-motion";

interface ListToggleIconProps {
  checked: boolean;
  size?: number;
  className?: string;
}

// The plus's two strokes become the check's two strokes: the bar folds down
// into the short leg, the upright swings over into the long one. Same
// commands on both sides, so every frame is a real line between real points.
const PATHS = {
  plus: { short: "M5 12 L19 12", long: "M12 5 L12 19" },
  check: { short: "M4.5 12.5 L9.5 17.5", long: "M9.5 17.5 L20 7" },
};

const morph = { type: "spring", bounce: 0, duration: 0.36 } as const;

/** "Add to My List" and "In My List" as one mark that changes its mind. */
export function ListToggleIcon({
  checked,
  size = 18,
  className = "",
}: ListToggleIconProps) {
  const shouldReduceMotion = useReducedMotion();
  const shape = checked ? PATHS.check : PATHS.plus;
  const transition = shouldReduceMotion ? { duration: 0 } : morph;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <motion.path
        initial={false}
        animate={{ d: shape.short }}
        transition={transition}
      />
      <motion.path
        initial={false}
        animate={{ d: shape.long }}
        transition={transition}
      />
    </svg>
  );
}
