/** How a title's state is coloured, shared by the library list and the title workspace. */
import type { HoldingTone } from "../../lib/libraryAdminApi";

export const TONE_STYLE: Record<
  HoldingTone,
  { card: string; dot: string; pill: string }
> = {
  held: {
    card: "border-emerald-400/30 bg-emerald-400/[0.04]",
    dot: "bg-emerald-400",
    pill: "bg-emerald-400/15 text-emerald-200",
  },
  downloading: {
    card: "border-violet-400/30 bg-violet-400/[0.04]",
    dot: "bg-violet-400",
    pill: "bg-violet-400/15 text-violet-200",
  },
  wanted: {
    card: "border-red-400/30 bg-red-400/[0.04]",
    dot: "bg-red-400",
    pill: "bg-red-400/15 text-red-200",
  },
  absent: {
    card: "border-white/10 bg-white/[0.03]",
    dot: "bg-white/25",
    pill: "bg-white/10 text-white/60",
  },
  unaired: {
    card: "border-white/10 bg-white/[0.02]",
    dot: "border border-white/35 bg-transparent",
    pill: "bg-white/5 text-white/45",
  },
};

export const actionButton =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-white/12 bg-white/[0.06] px-3 py-1.5 text-xs font-bold text-white/80 transition hover:bg-white/[0.11] hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

/** Turkish and English first, then a count: a film can carry thirty tracks. */
const FIRST_LANGUAGES = ["tur", "eng"];
export function languages(list: string[], shown = 4): string {
  const known = list
    .filter((language) => language !== "und")
    .sort(
      (a, b) =>
        (FIRST_LANGUAGES.indexOf(a) + 1 || 99) -
          (FIRST_LANGUAGES.indexOf(b) + 1 || 99) || a.localeCompare(b),
    );
  const head = known.slice(0, shown).map((language) => language.toUpperCase());
  return known.length > shown
    ? `${head.join(", ")} +${known.length - shown}`
    : head.join(", ");
}
