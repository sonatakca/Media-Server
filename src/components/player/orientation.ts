import type { PortraitPlayerRotation } from "./types";

export function readPortraitPlayerRotation(): PortraitPlayerRotation {
  if (typeof window === "undefined") {
    return 90;
  }

  const deprecatedWindowOrientation = (
    window as Window & { orientation?: number }
  ).orientation;
  const orientationAngle =
    window.screen.orientation?.angle ?? deprecatedWindowOrientation ?? 0;

  return Math.abs(orientationAngle) === 180 ? -90 : 90;
}
