import { formatRuntime } from "../../lib/format";
import type { MediaItem } from "../../lib/types";

/**
 * The rows of a phone's title page hero (`PhoneTitleHero`), each of a fixed
 * height, shared with its skeleton so each placeholder lands where its piece
 * will.
 */

export const PHONE_TITLE_HERO_SECTION = "relative w-full bg-[#050607] pb-6";
/**
 * The picture's frame: it starts under the navbar, so the wordmark and the
 * icons stand on the room rather than on the picture, and shows the
 * backdrop whole, the full width at its own 16:9, never cropped.
 */
export const PHONE_TITLE_HERO_FRAME =
  "relative w-full pt-[calc(3.5rem+env(safe-area-inset-top))]";
export const PHONE_TITLE_HERO_PICTURE =
  "relative aspect-video w-full overflow-hidden";
/**
 * The logo's box, at the picture's foot on the left: a signature on the
 * picture rather than a headline across it. It is never taller than the
 * room the picture leaves under back (which ends 4rem into it), so a narrow
 * phone's logo shrinks rather than running into it.
 */
export const PHONE_TITLE_HERO_LOGO_BOX =
  "absolute bottom-4 left-4 flex h-[clamp(2rem,calc(56.25vw-5.375rem),2.75rem)] w-[min(10.5rem,43vw)] items-end";
export const PHONE_TITLE_HERO_COPY = "px-4 pt-4";
export const PHONE_TITLE_HERO_FACTS = "flex h-5 items-center";
export const PHONE_TITLE_HERO_OVERVIEW = "mt-2 h-[4.5rem]";
export const PHONE_TITLE_HERO_ACTIONS = "mt-5";
/** Play, the full width. */
export const PHONE_TITLE_HERO_PLAY = "h-[3.125rem]";
/** The labelled actions under play: start over, My List, watched, download. */
export const PHONE_TITLE_HERO_ROW = "mt-[1.125rem] flex h-[3.25rem]";
/**
 * One labelled action: its mark over a short name, with no surface of its
 * own, since it stands on the room rather than on the picture.
 */
export const PHONE_TITLE_HERO_ACTION =
  "flex h-full w-full min-w-0 flex-col items-center gap-[7px] rounded-xl pt-0.5 text-[0.71875rem] font-semibold leading-4 text-white/[0.74] transition-colors duration-200 active:text-white aria-pressed:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] [&>span]:max-w-full [&>span]:truncate [&_svg]:text-white";
/** The size of a labelled action's mark. */
export const PHONE_TITLE_ACTION_ICON = 23;
/** The column each labelled action stands in. */
export const PHONE_TITLE_HERO_ACTION_SLOT =
  "flex min-w-0 flex-1 justify-center";

/**
 * Where the logo's box lies over the backdrop, as shares of it, on a 390px
 * phone (the backdrop is shown whole): what its shadow is measured against.
 */
export const PHONE_TITLE_LOGO_REGION = {
  left: 16 / 390,
  top: 1 - (16 + 44) / 219,
  width: 0.43,
  height: 44 / 219,
};

/** The facts line, as the home hero writes it. */
export function phoneTitleFacts(
  item: MediaItem,
  labels: { season: string; hourShort: string; minuteShort: string },
) {
  return [
    item.ProductionYear,
    formatRuntime(item.RunTimeTicks, labels),
    item.Genres?.filter(Boolean).slice(0, 2).join(", "),
  ]
    .filter(Boolean)
    .join("  ·  ");
}
