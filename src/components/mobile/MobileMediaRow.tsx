import type { JellyfinItem } from "../../lib/types";
import { MobileMediaCard } from "./MobileMediaCard";

interface MobileMediaRowProps {
  title: string;
  items: JellyfinItem[];
  getItemTo: (item: JellyfinItem) => string;
  variant?: "poster" | "landscape";
  emptyMessage?: string;
}

export function MobileMediaRow({
  title,
  items,
  getItemTo,
  variant = "poster",
  emptyMessage,
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
          {items.map((item) => (
            <MobileMediaCard
              key={item.Id}
              item={item}
              to={getItemTo(item)}
              variant={variant}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-white/10 bg-[var(--surface)] p-4 text-sm text-white/60">
          {emptyMessage}
        </p>
      )}
    </section>
  );
}
