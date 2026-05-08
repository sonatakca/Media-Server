import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

type RevealDirection = "up" | "down" | "left" | "right" | "none";

interface MotionRevealProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  direction?: RevealDirection;
  once?: boolean;
}

const easeOut: [number, number, number, number] = [0.22, 1, 0.36, 1];

function getOffset(direction: RevealDirection): { x?: number; y?: number } {
  switch (direction) {
    case "down":
      return { y: -18 };
    case "left":
      return { x: 18 };
    case "right":
      return { x: -18 };
    case "none":
      return {};
    case "up":
    default:
      return { y: 18 };
  }
}

export function MotionReveal({
  children,
  className = "",
  delay = 0,
  direction = "up",
  once = true,
}: MotionRevealProps) {
  const shouldReduceMotion = useReducedMotion();

  if (shouldReduceMotion) {
    return (
      <motion.div
        className={className}
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once, margin: "0px 0px -8% 0px" }}
        transition={{ duration: 0.01 }}
      >
        {children}
      </motion.div>
    );
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, ...getOffset(direction) }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once, margin: "0px 0px -8% 0px" }}
      transition={{ duration: 0.35, delay, ease: easeOut }}
    >
      {children}
    </motion.div>
  );
}
