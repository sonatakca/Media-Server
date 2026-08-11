/**
 * Buffers a media URL in a detached element before a quality switch.
 *
 * The switch tears the playing element down, so anything not already in the
 * HTTP cache is fetched from zero while the viewer watches a black frame. This
 * pulls the bytes first, at the position the viewer is actually at.
 */

/** Just the surface this needs, so a test does not need a real media element. */
export interface WarmableMedia {
  preload: string;
  muted: boolean;
  src: string;
  currentTime: number;
  readyState: number;
  load(): void;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface WarmQualityOptions {
  element: WarmableMedia;
  url: string;
  positionSeconds: number;
  budgetMs: number;
  /** True once a newer selection has replaced this one. */
  isSuperseded: () => boolean;
  setTimeout: (handler: () => void, timeout: number) => number;
  clearTimeout: (handle: number) => void;
  setInterval: (handler: () => void, timeout: number) => number;
  clearInterval: (handle: number) => void;
}

const SUPERSEDE_POLL_MS = 200;

/** HAVE_METADATA: duration and dimensions are known, so a seek will hold. */
const HAVE_METADATA = 1;

export function warmQualityAtPosition({
  element,
  url,
  positionSeconds,
  budgetMs,
  isSuperseded,
  setTimeout: schedule,
  clearTimeout: cancel,
  setInterval: schedulePoll,
  clearInterval: cancelPoll,
}: WarmQualityOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const target = Math.max(0, positionSeconds);
    let settled = false;
    let hasSought = target <= 0;

    const finish = () => {
      if (settled) return;
      settled = true;
      cancel(budget);
      cancelPoll(poll);
      element.removeEventListener("loadedmetadata", seekToTarget);
      element.removeEventListener("canplaythrough", onBuffered);
      element.removeEventListener("error", finish);
      resolve();
    };

    // Ready only counts once it is ready *where the viewer is*. Before the seek
    // the element is buffering the opening minutes, which is exactly the part
    // the switch will never play.
    const onBuffered = () => {
      if (hasSought) finish();
    };

    const seekToTarget = () => {
      try {
        element.currentTime = target;
        hasSought = true;
      } catch {
        // If the element refuses the seek there is nothing useful left to wait
        // for; the budget hands over to the ordinary path.
      }
    };

    const budget = schedule(finish, budgetMs);
    // A newer selection makes this warm-up pointless; stop holding the switch.
    const poll = schedulePoll(() => {
      if (isSuperseded()) finish();
    }, SUPERSEDE_POLL_MS);

    element.addEventListener("canplaythrough", onBuffered);
    element.addEventListener("error", finish, { once: true });
    element.preload = "auto";
    element.muted = true;
    element.src = url;
    element.load();

    // `load()` resets the position, so the seek has to come after metadata
    // rather than before it — otherwise it is silently discarded and the
    // warm-up buffers the start of the file instead of the part being switched
    // into.
    if (element.readyState >= HAVE_METADATA) {
      seekToTarget();
    } else {
      element.addEventListener("loadedmetadata", seekToTarget, { once: true });
    }
  });
}
