import { AnimatePresence } from "framer-motion";
import type { JellyfinItem } from "../../lib/types";
import { MobileMediaCard } from "./MobileMediaCard";

interface MobileMediaRowProps {
  title: string;
  items: JellyfinItem[];
  getItemTo: (item: JellyfinItem) => string;
  variant?: "poster" | "landscape";
  emptyMessage?: string;
  showRestartWatching?: boolean;
  onClearContinueWatching?: (item: JellyfinItem) => void;
}

export function MobileMediaRow({
  title,
  items,
  getItemTo,
  variant = "poster",
  emptyMessage,
  showRestartWatching = false,
  onClearContinueWatching,
}: MobileMediaRowProps) {
  if (items.length === 0 && !emptyMessage) {
    return null;
  }

  return (
    <section className="py-4">
      <h2 className="mb-3 text-xl font-black tracking-tight text-white">
        {title}
      </h2>

      {items.length > 0 ? (
        <div className="media-scroll -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2">
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <MobileMediaCard
                key={item.Id}
                item={item}
                to={getItemTo(item)}
                variant={variant}
                showRestartWatching={showRestartWatching}
                animateRemoval={Boolean(onClearContinueWatching)}
                onClearContinueWatching={onClearContinueWatching}
              />
            ))}
          </AnimatePresence>
        </div>
      ) : (
        <p className="rounded-xl border border-white/10 bg-[var(--surface)] p-4 text-sm text-white/60">
          {emptyMessage}
        </p>
      )}
    </section>
  );
}
