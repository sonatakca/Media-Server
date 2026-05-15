import type { JellyfinSyncPlaySendCommand } from "./partyWatchTypes";

export const JELLYFIN_TICKS_PER_SECOND = 10_000_000;
export const SYNCPLAY_DRIFT_CORRECTION_THRESHOLD_SECONDS = 1.25;

export function ticksFromSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return 0;
  }

  return Math.max(0, Math.floor(seconds * JELLYFIN_TICKS_PER_SECOND));
}

export function secondsFromTicks(ticks?: number | null): number | null {
  if (typeof ticks !== "number" || !Number.isFinite(ticks)) {
    return null;
  }

  return Math.max(0, ticks / JELLYFIN_TICKS_PER_SECOND);
}

export function getCommandDelayMs(
  command: JellyfinSyncPlaySendCommand,
  now = Date.now(),
): number {
  if (!command.When) {
    return 0;
  }

  const commandTime = Date.parse(command.When);

  if (!Number.isFinite(commandTime)) {
    return 0;
  }

  return Math.max(0, commandTime - now);
}

export function getExpectedCommandPositionSeconds(
  command: JellyfinSyncPlaySendCommand,
  now = Date.now(),
): number | null {
  const positionSeconds = secondsFromTicks(command.PositionTicks);

  if (positionSeconds === null) {
    return null;
  }

  if (command.Command !== "Unpause" || !command.When) {
    return positionSeconds;
  }

  const commandTime = Date.parse(command.When);

  if (!Number.isFinite(commandTime)) {
    return positionSeconds;
  }

  const elapsedSeconds = Math.max(0, (now - commandTime) / 1000);
  return positionSeconds + elapsedSeconds;
}

export function shouldCorrectSyncPlayDrift(
  currentSeconds: number,
  expectedSeconds: number,
  thresholdSeconds = SYNCPLAY_DRIFT_CORRECTION_THRESHOLD_SECONDS,
): boolean {
  return Math.abs(currentSeconds - expectedSeconds) > thresholdSeconds;
}
