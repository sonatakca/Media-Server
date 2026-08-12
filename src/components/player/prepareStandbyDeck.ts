/**
 * Brings a standby deck to the point where it can replace the active one
 * frame-to-frame.
 *
 * The scheme is a rendezvous rather than a chase. The standby seeks a little
 * *ahead* of the playhead, buffers, primes its decoder and then waits there
 * with a real frame painted while the active deck's clock catches up. At the
 * meeting point both decks hold the same instant, so promotion is an opacity
 * change rather than a seek — which is the whole reason a switch stops looking
 * like a reload.
 *
 * Written against a structural media interface rather than `HTMLVideoElement`
 * so the sequencing is testable without a decoder.
 */

import {
  HANDOFF_LEAD_SECONDS,
  HAVE_CURRENT_DATA,
  HAVE_FUTURE_DATA,
  HAVE_METADATA,
  MAX_RENDEZVOUS_ATTEMPTS,
  MIN_RENDEZVOUS_MARGIN_SECONDS,
  PAUSED_SYNC_TOLERANCE_SECONDS,
  PREPARE_DEADLINE_MS,
  requiredBufferAheadSeconds,
} from "./deckModel";

export interface DeckTimeRanges {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/** Exactly the surface preparation touches, so a fake can stand in for it. */
export interface DeckMedia {
  src: string;
  preload: string;
  muted: boolean;
  volume: number;
  playbackRate: number;
  currentTime: number;
  readonly duration: number;
  readonly readyState: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly videoWidth: number;
  readonly buffered: DeckTimeRanges;
  load(): void;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(
    type: string,
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: string, listener: () => void): void;
  requestVideoFrameCallback?(callback: () => void): number;
  cancelVideoFrameCallback?(handle: number): void;
}

export interface DeckClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
}

/** A live read of the active deck. Never a snapshot — the playhead moves. */
export interface ActiveDeckReading {
  positionSeconds: number;
  paused: boolean;
  playbackRate: number;
}

export type PrepareProgressEvent =
  | { type: "metadata-ready"; atMs: number }
  | {
      type: "seek-complete";
      atMs: number;
      handoffPointSeconds: number;
      rendezvousAttempts: number;
    }
  | { type: "frame-ready"; atMs: number; bufferedAheadSeconds: number };

export interface PrepareStandbyOptions {
  standby: DeckMedia;
  url: string;
  clock: DeckClock;
  readActive: () => ActiveDeckReading;
  /** True once a newer request has taken over, or the switch was cancelled. */
  isSuperseded: () => boolean;
  onProgress?: (event: PrepareProgressEvent) => void;
  deadlineMs?: number;
  leadSeconds?: number;
  /** How often the readiness predicates are re-checked between media events. */
  pollMs?: number;
  /** How long a decoded frame may take once the seek has already landed. */
  frameWaitMs?: number;
}

export type PrepareStandbyResult =
  | {
      outcome: "ready";
      handoffPointSeconds: number;
      bufferedAheadSeconds: number;
      rendezvousAttempts: number;
    }
  | { outcome: "superseded" }
  | { outcome: "failed"; reason: PrepareFailureReason };

export type PrepareFailureReason =
  | "metadata-timeout"
  | "media-error"
  | "seek-timeout"
  | "buffer-timeout"
  | "frame-timeout"
  | "rendezvous-overrun";

const DEFAULT_POLL_MS = 25;
const DEFAULT_FRAME_WAIT_MS = 4_000;
/** Longest a muted priming pulse is allowed to run before it is abandoned. */
const PRIME_PULSE_MS = 600;

class Superseded extends Error {}

class PrepareFailure extends Error {
  constructor(readonly reason: PrepareFailureReason) {
    super(reason);
  }
}

/** Continuous seconds buffered forward of `positionSeconds`. */
export function bufferedAheadOf(
  media: Pick<DeckMedia, "buffered">,
  positionSeconds: number,
): number {
  const { buffered } = media;

  for (let index = buffered.length - 1; index >= 0; index -= 1) {
    const start = buffered.start(index);
    const end = buffered.end(index);

    // A hair of tolerance at the lower edge: a seek frequently lands a few
    // milliseconds inside the keyframe rather than exactly on the range start.
    if (start <= positionSeconds + 0.05 && end > positionSeconds) {
      return end - positionSeconds;
    }
  }

  return 0;
}

export async function prepareStandbyDeck({
  standby,
  url,
  clock,
  readActive,
  isSuperseded,
  onProgress,
  deadlineMs = PREPARE_DEADLINE_MS,
  leadSeconds = HANDOFF_LEAD_SECONDS,
  pollMs = DEFAULT_POLL_MS,
  frameWaitMs = DEFAULT_FRAME_WAIT_MS,
}: PrepareStandbyOptions): Promise<PrepareStandbyResult> {
  const startedAtMs = clock.now();
  let mediaFailed = false;
  const onMediaError = () => {
    mediaFailed = true;
  };

  standby.addEventListener("error", onMediaError);

  /**
   * Waits for a predicate, woken by the media events that could satisfy it and
   * by a slow poll for the properties that change without an event of their
   * own (`buffered` most of all).
   */
  const waitUntil = (
    events: readonly string[],
    isSatisfied: () => boolean,
    timeoutMs: number,
    timeoutReason: PrepareFailureReason,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      // Held in one object so the cleanup can be written before the timers it
      // has to cancel are started.
      const timers: { poll?: number; deadline?: number } = {};

      const cleanUp = () => {
        settled = true;
        if (timers.poll !== undefined) clock.clearTimeout(timers.poll);
        if (timers.deadline !== undefined) clock.clearTimeout(timers.deadline);
        events.forEach((event) => standby.removeEventListener(event, check));
      };

      function check() {
        if (settled) return;

        if (isSuperseded()) {
          cleanUp();
          reject(new Superseded());
          return;
        }
        if (mediaFailed) {
          cleanUp();
          reject(new PrepareFailure("media-error"));
          return;
        }
        // The overall budget is reported against whichever stage was still
        // outstanding, because "preparation ran out of time" on its own says
        // nothing about which link in the chain was slow.
        if (clock.now() - startedAtMs > deadlineMs) {
          cleanUp();
          reject(new PrepareFailure(timeoutReason));
          return;
        }
        if (isSatisfied()) {
          cleanUp();
          resolve();
        }
      }

      const poll = () => {
        if (settled) return;
        check();
        if (!settled) timers.poll = clock.setTimeout(poll, pollMs);
      };

      events.forEach((event) => standby.addEventListener(event, check));
      timers.deadline = clock.setTimeout(() => {
        if (settled) return;
        cleanUp();
        reject(new PrepareFailure(timeoutReason));
      }, timeoutMs);

      poll();
    });

  /**
   * Resolves once the standby has actually presented a frame.
   *
   * Must be started *before* the seek that produces the frame it is waiting
   * for. `requestVideoFrameCallback` fires when a frame is proposed for
   * composition, so a callback registered after the deck has already presented
   * its frame and gone back to being paused waits for a frame that is never
   * coming.
   *
   * The two detection routes run together rather than one being a substitute
   * for the other: `requestVideoFrameCallback` is the direct answer where it
   * exists, and the events-plus-animation-frames route covers a browser that
   * lacks it, or that declines to fire it for an element the compositor
   * considers invisible. Whichever is satisfied first settles the wait.
   */
  const waitForDecodedFrame = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      // One holder for the same reason as above: the cleanup is written before
      // the handles it cancels exist.
      const timers: {
        frame?: number;
        raf?: number;
        deadline?: number;
      } = {};

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timers.deadline !== undefined) clock.clearTimeout(timers.deadline);
        if (timers.raf !== undefined) clock.cancelAnimationFrame(timers.raf);
        if (timers.frame !== undefined) {
          standby.cancelVideoFrameCallback?.(timers.frame);
        }
        standby.removeEventListener("loadeddata", fallbackTick);
        standby.removeEventListener("canplay", fallbackTick);
        standby.removeEventListener("seeked", fallbackTick);
        standby.removeEventListener("timeupdate", fallbackTick);

        if (error) reject(error);
        else resolve();
      };

      const guard = (): boolean => {
        if (isSuperseded()) {
          finish(new Superseded());
          return false;
        }
        if (mediaFailed) {
          finish(new PrepareFailure("media-error"));
          return false;
        }
        return true;
      };

      function fallbackTick() {
        if (settled || !guard()) return;
        if (standby.readyState < HAVE_CURRENT_DATA) return;
        if (standby.videoWidth <= 0) return;
        // Mid-seek the element still holds the previous frame, which is not
        // the one being waited for.
        if (standby.seeking) return;

        if (timers.raf !== undefined) return;
        timers.raf = clock.requestAnimationFrame(() => {
          timers.raf = clock.requestAnimationFrame(() => {
            timers.raf = undefined;
            if (guard()) finish();
          });
        });
      }

      timers.deadline = clock.setTimeout(
        () => finish(new PrepareFailure("frame-timeout")),
        frameWaitMs,
      );

      if (typeof standby.requestVideoFrameCallback === "function") {
        timers.frame = standby.requestVideoFrameCallback(() => {
          timers.frame = undefined;
          if (guard()) finish();
        });
      }

      standby.addEventListener("loadeddata", fallbackTick);
      standby.addEventListener("canplay", fallbackTick);
      standby.addEventListener("seeked", fallbackTick);
      standby.addEventListener("timeupdate", fallbackTick);
      fallbackTick();
    });

  /**
   * Runs the decoder briefly so the first frame after promotion comes from a
   * warm pipeline. Muted, hidden, and entirely optional: a browser that refuses
   * the play is not a reason to abandon a switch, because the seek has already
   * produced a decodable frame on its own.
   */
  const primeDecoder = async (): Promise<void> => {
    let played: Promise<void> | void;

    try {
      played = standby.play();
    } catch {
      return;
    }

    try {
      await played;
    } catch {
      // Autoplay policy said no even for muted playback. The seek's frame
      // stands on its own.
      return;
    }

    try {
      await waitUntil(
        ["timeupdate", "playing"],
        () => !standby.paused || standby.readyState >= HAVE_FUTURE_DATA,
        PRIME_PULSE_MS,
        "frame-timeout",
      );
    } catch (error) {
      if (error instanceof Superseded) throw error;
      // A pulse that never got going is not fatal either.
    } finally {
      standby.pause();
    }
  };

  try {
    // Step 1: hand the target bytes to the standby. Nothing about the active
    // deck is touched, so it keeps playing throughout everything below.
    standby.preload = "auto";
    standby.muted = true;
    standby.playbackRate = readActive().playbackRate;
    standby.src = url;
    standby.load();

    // Step 2: metadata, without which a seek would be silently discarded.
    await waitUntil(
      ["loadedmetadata", "durationchange", "canplay"],
      () =>
        standby.readyState >= HAVE_METADATA &&
        Number.isFinite(standby.duration) &&
        standby.duration > 0,
      deadlineMs,
      "metadata-timeout",
    );
    onProgress?.({ type: "metadata-ready", atMs: clock.now() });

    for (let attempt = 1; attempt <= MAX_RENDEZVOUS_ATTEMPTS; attempt += 1) {
      // Step 3: pick the meeting point from the playhead *now*, not from where
      // it was when preparation started. On a slow link those differ by more
      // than the lead, and seeking to the stale position is exactly how a
      // prepared switch ends up promoting into the past.
      const active = readActive();
      const ceiling = Math.max(0, standby.duration - 0.25);
      const handoffPointSeconds = Math.min(
        ceiling,
        Math.max(
          0,
          active.paused
            ? active.positionSeconds
            : active.positionSeconds + leadSeconds,
        ),
      );

      // Started before the seek, because the frame it is waiting for is the
      // one the seek is about to present.
      const decodedFrame = waitForDecodedFrame();
      // A rejection that arrives while the seek or buffer wait is still being
      // awaited would otherwise surface as an unhandled rejection.
      decodedFrame.catch(() => undefined);

      standby.currentTime = handoffPointSeconds;
      await waitUntil(
        ["seeked"],
        () =>
          Math.abs(standby.currentTime - handoffPointSeconds) <= 0.5 &&
          standby.readyState >= HAVE_CURRENT_DATA,
        deadlineMs,
        "seek-timeout",
      );
      onProgress?.({
        type: "seek-complete",
        atMs: clock.now(),
        handoffPointSeconds,
        rendezvousAttempts: attempt,
      });

      // Step 4: useful data *past* the meeting point, so promotion does not
      // simply move the stall a second later.
      await waitUntil(
        ["progress", "canplay", "canplaythrough", "loadeddata"],
        () =>
          standby.readyState >= HAVE_FUTURE_DATA &&
          bufferedAheadOf(standby, standby.currentTime) >=
            requiredBufferAheadSeconds(standby.currentTime, standby.duration),
        deadlineMs,
        "buffer-timeout",
      );

      // Step 5 and 6: warm the decoder, then insist on a real frame.
      //
      // The priming pulse is skipped against a paused deck. There is no clock
      // to meet, so the standby has to hold the viewer's exact frame, and a
      // pulse would nudge it off that frame for no benefit — the seek has
      // already decoded what needs to be painted.
      if (!readActive().paused) {
        await primeDecoder();
      }
      await decodedFrame;

      // Step 7: did the active clock overtake the meeting point while all of
      // that happened? If so this deck is parked in the past and must not be
      // promoted; seek further ahead and try again.
      const settledActive = readActive();
      const parkedAtSeconds = standby.currentTime;
      const marginSeconds = parkedAtSeconds - settledActive.positionSeconds;
      const hasOvertaken = settledActive.paused
        ? Math.abs(marginSeconds) > PAUSED_SYNC_TOLERANCE_SECONDS
        : marginSeconds < MIN_RENDEZVOUS_MARGIN_SECONDS;

      if (hasOvertaken && attempt < MAX_RENDEZVOUS_ATTEMPTS) {
        continue;
      }
      if (hasOvertaken) {
        return { outcome: "failed", reason: "rendezvous-overrun" };
      }

      const bufferedAheadSeconds = bufferedAheadOf(standby, parkedAtSeconds);
      onProgress?.({
        type: "frame-ready",
        atMs: clock.now(),
        bufferedAheadSeconds,
      });

      return {
        outcome: "ready",
        handoffPointSeconds: parkedAtSeconds,
        bufferedAheadSeconds,
        rendezvousAttempts: attempt,
      };
    }

    return { outcome: "failed", reason: "rendezvous-overrun" };
  } catch (error) {
    if (error instanceof Superseded) return { outcome: "superseded" };
    if (error instanceof PrepareFailure) {
      return { outcome: "failed", reason: error.reason };
    }
    return { outcome: "failed", reason: "media-error" };
  } finally {
    standby.removeEventListener("error", onMediaError);
  }
}

/**
 * Returns a standby deck to a clean, sourceless state.
 *
 * Called only once the switch is over — either because the promoted deck has
 * proved stable, or because the attempt was abandoned. Never while a deck could
 * still be needed for rollback.
 */
export function releaseDeck(media: DeckMedia): void {
  try {
    media.pause();
  } catch {
    // A deck that will not pause is about to lose its source anyway.
  }

  try {
    media.src = "";
    (
      media as unknown as { removeAttribute?: (name: string) => void }
    ).removeAttribute?.("src");
    media.load();
  } catch {
    // Ignore reset failures; nothing downstream depends on this succeeding.
  }
}
