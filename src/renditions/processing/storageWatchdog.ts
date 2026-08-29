import { stat } from "node:fs/promises";

/**
 * Noticing that the media volume went away, and that it came back.
 *
 * An external drive that is unplugged mid-encode does not produce one clean
 * error: it produces a stream of I/O failures, one per title, and a queue left
 * to itself will march through every remaining item failing each in turn. By
 * the time anyone looks, the queue is empty and every job is marked failed —
 * none of which had anything wrong with it.
 *
 * Watching the root directly turns that into a single fact the queue can act
 * on: the storage is gone, so stop starting work and wait for it to return.
 */

export interface StorageWatchdogOptions {
  /** Directory that must exist and be readable for work to proceed. */
  mediaRoot: string;
  /** How often to look. */
  intervalMs?: number;
  onLost?: () => void | Promise<void>;
  onRestored?: () => void | Promise<void>;
  /** Injected in tests. */
  check?: (path: string) => Promise<boolean>;
}

export interface StorageWatchdog {
  readonly available: boolean;
  /** Checks once, right now, and reports availability. */
  poll(): Promise<boolean>;
  start(): void;
  stop(): void;
}

/**
 * A directory that exists and can be listed.
 *
 * An unmounted volume under `/Volumes` usually vanishes entirely, but a
 * half-detached one can linger as an empty directory that throws on access, so
 * the check reads it rather than merely testing for its presence.
 */
export async function isStorageAvailable(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    return entry.isDirectory();
  } catch {
    return false;
  }
}

export function createStorageWatchdog({
  mediaRoot,
  intervalMs = 5_000,
  onLost,
  onRestored,
  check = isStorageAvailable,
}: StorageWatchdogOptions): StorageWatchdog {
  // Assumed present until proven otherwise: a watchdog that starts by
  // announcing the storage is missing would pause a healthy queue for one
  // interval every time the server restarts.
  let available = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  const poll = async (): Promise<boolean> => {
    // A slow volume can take longer to answer than the interval; overlapping
    // checks would report flapping that never happened.
    if (inFlight) return available;
    inFlight = true;
    try {
      const nowAvailable = await check(mediaRoot);
      if (nowAvailable !== available) {
        available = nowAvailable;
        await (nowAvailable ? onRestored?.() : onLost?.());
      }
      return available;
    } finally {
      inFlight = false;
    }
  };

  return {
    get available() {
      return available;
    },
    poll,
    start() {
      if (timer) return;
      timer = setInterval(() => void poll(), intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
