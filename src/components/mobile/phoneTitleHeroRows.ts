import { formatRuntime } from "../../lib/format";
import type { MediaItem } from "../../lib/types";

/**
 * The rows of a phone's title page hero (`PhoneTitleHero`), each of a fixed
 * height, shared with its skeleton so each placeholder lands where its piece
 * will.
 */

/** The section: room for the navbar and the furniture row above the frame. */
export const PHONE_TITLE_HERO_SECTION =
  "relative w-full bg-[#050607] pb-6 pt-[calc(8.25rem+env(safe-area-inset-top))]";
/** The picture's frame: full width, the backdrop's own shape. */
export const PHONE_TITLE_HERO_FRAME =
  "relative aspect-video w-full overflow-hidden";
export const PHONE_TITLE_HERO_COPY = "px-4 pt-5";
/** The logo's box; a logo is fitted inside it, standing on its foot. */
export const PHONE_TITLE_HERO_LOGO_BOX =
  "flex h-[5.5rem] w-[min(20rem,76vw)] items-end";
export const PHONE_TITLE_HERO_FACTS = "mt-3 flex h-5 items-center";
/**
 * Three lines of overview, where the screen has the height for them. On a
 * short phone the row goes, so play stays above the tab bar; the page's
 * "About" carries the overview in full either way.
 */
export const PHONE_TITLE_HERO_OVERVIEW =
  "mt-3 h-[4.5rem] [@media(max-height:700px)]:hidden";
export const PHONE_TITLE_HERO_ACTIONS = "mt-5 h-12";

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
