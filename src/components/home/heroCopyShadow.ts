/**
 * The two black shadows the hero copy stands on, and which one the art
 * behind it gets (see `copyTextStyle` in HeroCopy.tsx for why there are two).
 */
export const COPY_SHADOW_ON_BRIGHT =
  "drop-shadow(0 0 1px rgba(0,0,0,0.95)) drop-shadow(0 1px 3px rgba(0,0,0,0.9)) drop-shadow(0 0 8px rgba(0,0,0,0.8)) drop-shadow(0 0 16px rgba(0,0,0,0.6))";
export const COPY_SHADOW_ON_DARK =
  "drop-shadow(0 0 1px rgba(0,0,0,1)) drop-shadow(0 0 2px rgba(0,0,0,0.95)) drop-shadow(0 0 6px rgba(0,0,0,0.9)) drop-shadow(0 0 12px rgba(0,0,0,0.8)) drop-shadow(0 0 16px rgba(0,0,0,0.6))";
/** The shade from which the art counts as bright (white sky: 1, night: 0.25). */
const BRIGHT_ART_SHADE = 0.6;

export function copyShadowFor(shade: number): string {
  return shade >= BRIGHT_ART_SHADE
    ? COPY_SHADOW_ON_BRIGHT
    : COPY_SHADOW_ON_DARK;
}
