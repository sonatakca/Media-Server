/**
 * Position on a source timeline, as a clock: `01:07:32`.
 *
 * Shared rather than owned by the processing page, because a notification card
 * and that page describe the same encode and must never disagree about where
 * it has got to. Floored, so a clock never claims a second that has not been
 * encoded.
 */
export function formatMediaClock(seconds: number | null | undefined): string {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return "--:--:--";
  }
  const whole = Math.floor(seconds);
  const hours = String(Math.floor(whole / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const rest = String(whole % 60).padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
}
