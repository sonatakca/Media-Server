import type { JellyfinItem } from "./types";

export const DEFAULT_COMPLETION_THRESHOLD = 0.9;

function getPlayedRatio(item: JellyfinItem): number {
  const playedPercentage = item.UserData?.PlayedPercentage;

  if (
    typeof playedPercentage === "number" &&
    Number.isFinite(playedPercentage)
  ) {
    return playedPercentage > 1 ? playedPercentage / 100 : playedPercentage;
  }

  const positionTicks = item.UserData?.PlaybackPositionTicks;
  const runtimeTicks = item.RunTimeTicks;

  if (
    typeof positionTicks === "number" &&
    typeof runtimeTicks === "number" &&
    runtimeTicks > 0
  ) {
    return positionTicks / runtimeTicks;
  }

  return 0;
}

export function isItemCompleted(
  item: JellyfinItem,
  completionThreshold = DEFAULT_COMPLETION_THRESHOLD,
): boolean {
  return Boolean(
    item.UserData?.Played || getPlayedRatio(item) >= completionThreshold,
  );
}

export function getItemProgressPercent(item: JellyfinItem): number | null {
  if (isItemCompleted(item)) {
    return 100;
  }

  const playedPercentage = item.UserData?.PlayedPercentage;

  if (
    typeof playedPercentage === "number" &&
    Number.isFinite(playedPercentage)
  ) {
    return Math.min(100, Math.max(0, playedPercentage));
  }

  const positionTicks = item.UserData?.PlaybackPositionTicks;
  const runtimeTicks = item.RunTimeTicks;

  if (
    typeof positionTicks === "number" &&
    positionTicks > 0 &&
    typeof runtimeTicks === "number" &&
    runtimeTicks > 0
  ) {
    return Math.min(100, Math.max(0, (positionTicks / runtimeTicks) * 100));
  }

  return null;
}
