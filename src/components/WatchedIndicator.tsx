import { motion, useReducedMotion } from "framer-motion";
import { CheckCircle2 } from "lucide-react";
import { useLanguage } from "../i18n/LanguageContext";
import type { JellyfinItem } from "../lib/types";
import { isItemCompleted } from "../lib/watchStatus";

interface WatchedIndicatorProps {
  item?: JellyfinItem;
  isWatched?: boolean;
  className?: string;
  iconSize?: number;
  showLabel?: boolean;
}

export function WatchedIndicator({
  item,
  isWatched,
  className = "",
  iconSize = 14,
  showLabel = true,
}: WatchedIndicatorProps) {
  const { t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const watched = isWatched ?? (item ? isItemCompleted(item) : false);

  if (!watched) {
    return null;
  }

  const label = t("details.watched");

  return (
    <motion.span
      aria-label={label}
      className={`inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-100/80 bg-emerald-300 px-2.5 py-1 text-[0.68rem] font-black uppercase tracking-[0.16em] text-black shadow-[0_0_24px_rgba(52,211,153,0.38)] ${className}`}
      initial={
        shouldReduceMotion
          ? { opacity: 0 }
          : { opacity: 0, scale: 0.72, y: -6, filter: "blur(5px)" }
      }
      animate={
        shouldReduceMotion
          ? { opacity: 1 }
          : { opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }
      }
      transition={
        shouldReduceMotion
          ? { duration: 0.12 }
          : { duration: 0.34, ease: [0.22, 1, 0.36, 1] }
      }
    >
      <CheckCircle2 size={iconSize} strokeWidth={2.8} />
      {showLabel ? <span>{label}</span> : null}
    </motion.span>
  );
}
