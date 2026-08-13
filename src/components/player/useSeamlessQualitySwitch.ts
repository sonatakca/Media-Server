/**
 * Dual-deck rendition switching.
 *
 * Two full-size video elements share the viewport. One is active — visible,
 * audible, and the element every control, hook and listener means when it says
 * "the video". The other is standby: hidden, muted, inert, and loading the next
 * quality. On a successful handoff the two swap roles, and the element that did
 * the preparing becomes the one that plays. The prepared bytes and the decoded
 * frame are never handed to a third element, because they cannot be.
 *
 * The old single-element path assigned a new `src` to the playing element. That
 * discards the decode pipeline, the buffer and the position in one statement,
 * which is why the viewer saw a black frame, a `00:00 / 00:00` clock and a
 * second buffering wait. Nothing here ever writes to the active element's
 * source.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import {
  AUTO_RETRY_BACKOFF_MS,
  HANDOFF_CROSSFADE_MS,
  MANUAL_PREPARE_DEADLINE_MS,
  MAX_HANDOFF_DRIFT_SECONDS,
  OTHER_DECK,
  PREPARE_DEADLINE_MS,
  RENDEZVOUS_TARGET_SECONDS,
  STABILIZE_MS,
  buildSwitchDiagnostics,
  classifySwitchReason,
  evaluatePromotionReadiness,
  initialSwitchState,
  isSwitchInFlight,
  reduceSwitch,
  type DeckId,
  type SwitchDiagnostics,
  type SwitchEvent,
  type RendezvousWaitRecord,
  type SwitchOutcome,
  type SwitchState,
} from "./deckModel";
import {
  bufferedAheadOf,
  prepareStandbyDeck,
  releaseDeck,
  type DeckClock,
  type DeckMedia,
} from "./prepareStandbyDeck";

export { HANDOFF_CROSSFADE_MS };

/**
 * A jump larger than this in the active deck's clock is a seek, not playback,
 * and invalidates a standby prepared for the old timeline position.
 */
const SEEK_DETECTION_SECONDS = 1.5;

/**
 * Longest the rendezvous may be waited for, measured in time the active deck is
 * actually *moving*.
 *
 * Wall-clock was wrong here. Preparing a second rendition competes for
 * bandwidth with the one playing, so on a constrained link the active deck
 * stalls — and a stalled clock can never reach the meeting point. Counting that
 * against the budget abandoned switches whose standby was fully prepared and
 * simply waiting, which is the opposite of what should happen: a parked standby
 * costs nothing to hold. The budget therefore only advances while the playhead
 * does, and a genuinely stuck rendezvous still fails.
 */
const RENDEZVOUS_STALL_BUDGET_MS = 12_000;

/**
 * How often the rendezvous re-checks the two clocks.
 *
 * A timer rather than `requestAnimationFrame`: this is a clock comparison, not
 * a paint, and rAF is throttled hard under decode load and in background tabs.
 * The visual side of the handoff still waits on frames — only the decision of
 * *when* to promote runs here.
 */
const RENDEZVOUS_POLL_MS = 50;

/**
 * Bounds on how far ahead the standby is re-aimed after being overtaken.
 *
 * The lead must exceed the media distance the playhead covers between two
 * consecutive checks, or the new target is skipped over exactly like the old
 * one and the switch chases itself until the budget expires. It is otherwise
 * kept small: the re-aim lands inside the buffer the original park pulled, and
 * every extra second is a second the viewer waits.
 */
const RENDEZVOUS_RESYNC_LEAD_SECONDS = 0.4;
const MAX_RENDEZVOUS_RESYNC_LEAD_SECONDS = 5;

/**
 * Safety factor on the measured sampling interval.
 *
 * Two would be the bare minimum to survive one interval of jitter; three leaves
 * room for a second consecutive slow sample without another round trip.
 */
const RENDEZVOUS_RESYNC_TICK_MULTIPLE = 3;

/**
 * Samples the sampling-interval estimate remembers.
 *
 * A single pause — a GC, a tab switch, a decode stall — must not inflate the
 * lead for the rest of the wait, so the estimate is the worst of a short recent
 * window rather than an all-time maximum.
 */
const RENDEZVOUS_TICK_WINDOW = 8;

/** Re-aims allowed before the wait gives up, so it cannot chase indefinitely. */
const MAX_RENDEZVOUS_RESYNCS = 4;

export interface SeamlessSwitchRequest {
  url: string;
  toQualityId: string;
  toHeight: number;
  fromQualityId: string | null;
  fromHeight: number | null;
  isManual: boolean;
}

/** The latest user intent, read at the moment of promotion rather than cached. */
export interface PlaybackIntent {
  volume: number;
  muted: boolean;
  playbackRate: number;
  wantsToPlay: boolean;
}

export interface UseSeamlessQualitySwitchOptions {
  /**
   * Commits the promoted source. Called once, during a successful handoff, and
   * never during preparation — which is what keeps the quality label, the
   * controls and the reporting from moving before the picture does.
   */
  onPromoted: (commit: {
    toQualityId: string;
    url: string;
    deckId: DeckId;
  }) => void;
  readIntent: () => PlaybackIntent;
  /**
   * Undoes the commit `onPromoted` made, when the promoted deck turns out to be
   * unplayable and the old one is put back.
   *
   * Without this the committed source and the deck actually on screen disagree:
   * the source says the new quality, the deck is playing the old one, and the
   * next time anything re-reads the source it attaches the quality that just
   * failed onto the healthy deck — which is a black screen.
   */
  onRolledBack?: (info: {
    restoredQualityId: string | null;
    deckId: DeckId;
  }) => void;
  onDiagnostics?: (diagnostics: SwitchDiagnostics) => void;
  clock?: DeckClock;
  /** How long the old deck is retained for rollback after a promotion. */
  stabiliseMs?: number;
}

export interface SeamlessQualitySwitchApi {
  /**
   * The single authoritative way to reach the logical active video element.
   *
   * Repointed synchronously at the instant of a promotion, so a read taken from
   * anywhere — a control, a hook, an interval — always lands on the deck that
   * is actually playing.
   */
  videoRef: RefObject<HTMLVideoElement>;
  activeDeckId: DeckId;
  standbyDeckId: DeckId;
  /**
   * Bumped on every promotion. Effects that attach listeners to the active
   * element depend on this so they rebind to the deck that is now playing
   * instead of staying bolted to whichever element was active at mount.
   */
  deckEpoch: number;
  setDeckElement: (deckId: DeckId, element: HTMLVideoElement | null) => void;
  /** Stable `ref` callbacks, one per deck. Must be used as-is in the JSX. */
  deckRefs: Record<DeckId, (element: HTMLVideoElement | null) => void>;
  getDeckElement: (deckId: DeckId) => HTMLVideoElement | null;
  isActiveDeckElement: (element: EventTarget | null) => boolean;
  requestSwitch: (request: SeamlessSwitchRequest) => Promise<SwitchOutcome>;
  cancelSwitch: (reason: string) => void;
  /** Invalidates a standby prepared for a position the viewer has left. */
  notifyActiveSeek: () => void;
  isPreparing: boolean;
  pendingQualityId: string | null;
  /** True while the old deck is held loaded in case the new one fails. */
  isRetainedDeckElement: (element: HTMLVideoElement | null) => boolean;
  isBackedOff: (qualityId: string) => boolean;
  switchState: SwitchState;
}

const defaultClock: DeckClock = {
  now: () =>
    typeof performance === "undefined" ? Date.now() : performance.now(),
  setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
  requestAnimationFrame: (callback) =>
    typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(() => callback())
      : window.setTimeout(callback, 16),
  cancelAnimationFrame: (handle) => {
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(handle);
    } else {
      window.clearTimeout(handle);
    }
  },
};

function asDeckMedia(element: HTMLVideoElement): DeckMedia {
  return element as unknown as DeckMedia;
}

export function useSeamlessQualitySwitch({
  onPromoted,
  readIntent,
  onRolledBack,
  onDiagnostics,
  clock = defaultClock,
  stabiliseMs = STABILIZE_MS,
}: UseSeamlessQualitySwitchOptions): SeamlessQualitySwitchApi {
  const deckElementsRef = useRef<Record<DeckId, HTMLVideoElement | null>>({
    a: null,
    b: null,
  });

  /**
   * The synchronous authority on which deck is active.
   *
   * React state drives the rendering, but a promotion has to be true the
   * instant it happens: the old deck is paused a couple of frames later and
   * that pause must already be recognisable as the standby's, not the
   * viewer's.
   */
  const activeDeckIdRef = useRef<DeckId>("a");
  const [activeDeckId, setActiveDeckId] = useState<DeckId>("a");
  const [deckEpoch, setDeckEpoch] = useState(0);
  const [switchState, setSwitchState] =
    useState<SwitchState>(initialSwitchState);
  const [isPreparing, setIsPreparing] = useState(false);
  const [pendingQualityId, setPendingQualityId] = useState<string | null>(null);

  const switchStateRef = useRef<SwitchState>(initialSwitchState);
  const tokenRef = useRef(0);
  /**
   * Cancelled and superseded are both "may not promote", but they are not the
   * same event and the diagnostics have to tell them apart: one is the viewer
   * moving, the other is Auto changing its mind.
   */
  const cancelledTokensRef = useRef(new Set<number>());
  const supersededTokensRef = useRef(new Set<number>());
  /**
   * The request currently allowed to mutate each standby deck.
   *
   * Superseded requests finish asynchronously. Without explicit ownership, an
   * older request can reach its cleanup after its replacement has promoted the
   * same element, then pause it and remove its source. That presents as a
   * successful quality change followed immediately by a paused or black player.
   */
  const preparationOwnerRef = useRef<Record<DeckId, number | null>>({
    a: null,
    b: null,
  });
  const retainedDeckRef = useRef<HTMLVideoElement | null>(null);
  const stabiliseTimerRef = useRef<number | null>(null);
  const backoffRef = useRef(new Map<string, number>());
  const isUnmountedRef = useRef(false);
  const readIntentRef = useRef(readIntent);
  const onPromotedRef = useRef(onPromoted);
  const onRolledBackRef = useRef(onRolledBack);
  const onDiagnosticsRef = useRef(onDiagnostics);

  readIntentRef.current = readIntent;
  onPromotedRef.current = onPromoted;
  onRolledBackRef.current = onRolledBack;
  onDiagnosticsRef.current = onDiagnostics;

  const dispatch = useCallback((event: SwitchEvent) => {
    const next = reduceSwitch(switchStateRef.current, event);
    if (next === switchStateRef.current) return next;
    switchStateRef.current = next;
    if (!isUnmountedRef.current) setSwitchState(next);
    return next;
  }, []);

  const getDeckElement = useCallback(
    (deckId: DeckId) => deckElementsRef.current[deckId],
    [],
  );

  /**
   * The element every existing `videoRef.current` read in the player resolves
   * to. Repointed by `syncActiveVideoRef` — which is called from the only three
   * places the answer can change: a deck mounting, a promotion, and a rollback.
   */
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const syncActiveVideoRef = useCallback(() => {
    videoRef.current = deckElementsRef.current[activeDeckIdRef.current];
  }, []);

  const setDeckElement = useCallback(
    (deckId: DeckId, element: HTMLVideoElement | null) => {
      deckElementsRef.current[deckId] = element;
      syncActiveVideoRef();
    },
    [syncActiveVideoRef],
  );

  /**
   * Stable per-deck ref callbacks.
   *
   * These have to keep their identity across renders. React re-runs a ref
   * callback whose identity changed by first calling the old one with `null`,
   * so an inline arrow in the JSX would detach both decks on every render —
   * including the renders a switch causes — and preparation would be handing
   * bytes to an element the controller had just been told did not exist.
   */
  const deckRefs = useMemo(
    (): Record<DeckId, (element: HTMLVideoElement | null) => void> => ({
      a: (element) => setDeckElement("a", element),
      b: (element) => setDeckElement("b", element),
    }),
    [setDeckElement],
  );

  const isActiveDeckElement = useCallback(
    (element: EventTarget | null) =>
      element !== null &&
      element === deckElementsRef.current[activeDeckIdRef.current],
    [],
  );

  const isRetainedDeckElement = useCallback(
    (element: HTMLVideoElement | null) =>
      element !== null && element === retainedDeckRef.current,
    [],
  );

  const isBackedOff = useCallback((qualityId: string) => {
    const until = backoffRef.current.get(qualityId);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      backoffRef.current.delete(qualityId);
      return false;
    }
    return true;
  }, []);

  const isSuperseded = useCallback(
    (token: number) =>
      isUnmountedRef.current ||
      token !== tokenRef.current ||
      cancelledTokensRef.current.has(token) ||
      supersededTokensRef.current.has(token),
    [],
  );

  const cancelSwitch = useCallback(
    (reason: string) => {
      const current = switchStateRef.current.request;
      if (!current) return;
      cancelledTokensRef.current.add(current.token);
      dispatch({ type: "cancel", token: current.token, atMs: clock.now() });
      void reason;
    },
    [clock, dispatch],
  );

  const notifyActiveSeek = useCallback(() => {
    // A standby parked for the old position is worthless and must never be
    // promoted there. Preparation restarts from wherever the viewer landed.
    if (switchStateRef.current.phase === "idle") return;
    cancelSwitch("active-deck-seek");
  }, [cancelSwitch]);

  const clearStabiliseTimer = useCallback(() => {
    if (stabiliseTimerRef.current !== null) {
      clock.clearTimeout(stabiliseTimerRef.current);
      stabiliseTimerRef.current = null;
    }
  }, [clock]);

  const emitDiagnostics = useCallback((outcome: SwitchOutcome) => {
    const diagnostics = buildSwitchDiagnostics(switchStateRef.current, outcome);
    if (diagnostics) onDiagnosticsRef.current?.(diagnostics);
  }, []);

  const delay = useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        clock.setTimeout(() => resolve(), ms);
      }),
    [clock],
  );

  /** Resolves when a seek settles, or on the next frame if it never reports. */
  const waitForSeeked = useCallback(
    (element: HTMLVideoElement) =>
      new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          element.removeEventListener("seeked", finish);
          clock.clearTimeout(guard);
          resolve();
        };
        const guard = clock.setTimeout(finish, 2_000);
        element.addEventListener("seeked", finish);
      }),
    [clock],
  );

  const nextFrame = useCallback(
    () =>
      new Promise<void>((resolve) => {
        clock.requestAnimationFrame(() => resolve());
      }),
    [clock],
  );

  /**
   * The swap itself.
   *
   * Everything that decides *whether* to swap has already happened; this only
   * moves ownership, and it moves picture and sound together so the two can
   * never be split across decks.
   */
  const performHandoff = useCallback(
    async (
      fromDeck: DeckId,
      toDeck: DeckId,
      commit: { toQualityId: string; url: string },
    ) => {
      const oldElement = deckElementsRef.current[fromDeck];
      const newElement = deckElementsRef.current[toDeck];
      if (!oldElement || !newElement) return false;

      const intent = readIntentRef.current();

      // Playback rate and audio settings move first, while the new deck is
      // still hidden, so nothing is heard or seen mid-transfer.
      newElement.playbackRate = intent.playbackRate;
      newElement.volume = intent.volume;
      newElement.muted = intent.muted;

      // One operation, two decks: the old one gives up audio in the same step
      // the new one takes it, so both are never audible at once.
      oldElement.muted = true;

      if (intent.wantsToPlay) {
        void Promise.resolve(newElement.play()).catch(() => {
          // A play issued at the instant of promotion can be rejected by work
          // still settling on the element — an aborted load on a slow link is
          // the common one. Swallowing that left the viewer looking at a
          // correctly promoted but permanently paused picture, so it is retried
          // once the deck says it is ready. The intent is re-read then, because
          // by that point the viewer may genuinely have pressed pause.
          const retryWhenReady = () => {
            newElement.removeEventListener("canplay", retryWhenReady);
            if (isUnmountedRef.current) return;
            if (!readIntentRef.current().wantsToPlay) return;
            void Promise.resolve(newElement.play()).catch(() => undefined);
          };
          newElement.addEventListener("canplay", retryWhenReady);
        });
      } else {
        newElement.pause();
      }

      // Promote. The ref moves synchronously — from here on the new element is
      // what `videoRef.current` means and what the event guards accept — and
      // the state moves the picture.
      retainedDeckRef.current = oldElement;
      activeDeckIdRef.current = toDeck;
      syncActiveVideoRef();
      if (!isUnmountedRef.current) {
        setActiveDeckId(toDeck);
        setDeckEpoch((epoch) => epoch + 1);
      }

      onPromotedRef.current({ ...commit, deckId: toDeck });

      // The old deck keeps painting until the new one has actually been
      // composited. Two frames is the cheapest guarantee that the swap has
      // reached the screen before the outgoing picture stops.
      await nextFrame();
      await nextFrame();
      oldElement.pause();

      return true;
    },
    [nextFrame, syncActiveVideoRef],
  );

  /**
   * Holds the old deck loaded briefly, so a target that dies on contact can be
   * undone without the viewer seeing anything.
   */
  const watchForRollback = useCallback(
    (token: number, fromDeck: DeckId, toDeck: DeckId) => {
      const promotedElement = deckElementsRef.current[toDeck];
      const oldElement = deckElementsRef.current[fromDeck];
      if (!promotedElement) return;

      const newElement: HTMLVideoElement = promotedElement;
      let settled = false;

      const finish = (rolledBack: boolean, reason?: string) => {
        if (settled) return;
        settled = true;
        newElement.removeEventListener("error", onNewDeckError);
        clearStabiliseTimer();

        if (rolledBack && oldElement) {
          const intent = readIntentRef.current();
          oldElement.muted = intent.muted;
          oldElement.volume = intent.volume;
          oldElement.playbackRate = intent.playbackRate;
          newElement.muted = true;
          newElement.pause();

          activeDeckIdRef.current = fromDeck;
          syncActiveVideoRef();
          // Ordered before the re-render so the restored source is committed by
          // the time any effect re-reads it.
          onRolledBackRef.current?.({
            restoredQualityId:
              switchStateRef.current.request?.fromQualityId ?? null,
            deckId: fromDeck,
          });
          if (!isUnmountedRef.current) {
            setActiveDeckId(fromDeck);
            setDeckEpoch((epoch) => epoch + 1);
          }
          if (intent.wantsToPlay) {
            void Promise.resolve(oldElement.play()).catch(() => undefined);
          }

          retainedDeckRef.current = null;
          releaseDeck(asDeckMedia(newElement));
          dispatch({
            type: "rollback",
            token,
            atMs: clock.now(),
            reason: reason ?? "promoted-deck-failed",
          });
          emitDiagnostics("rolled-back");
          return;
        }

        // Stable. Only now is the old deck cleared, and only so that it can
        // serve as the next standby.
        retainedDeckRef.current = null;
        if (oldElement) releaseDeck(asDeckMedia(oldElement));
        dispatch({ type: "settled", token, atMs: clock.now() });
        emitDiagnostics("promoted");
      };

      function onNewDeckError() {
        const stillHealthy =
          oldElement !== null &&
          oldElement !== undefined &&
          Number.isFinite(oldElement.duration) &&
          oldElement.duration > 0 &&
          Math.abs(oldElement.currentTime - newElement.currentTime) <=
            MAX_HANDOFF_DRIFT_SECONDS * 8;

        finish(stillHealthy, "promoted-deck-error");
      }

      newElement.addEventListener("error", onNewDeckError);
      clearStabiliseTimer();
      stabiliseTimerRef.current = clock.setTimeout(
        () => finish(false),
        stabiliseMs,
      );
    },
    [
      clearStabiliseTimer,
      clock,
      dispatch,
      emitDiagnostics,
      stabiliseMs,
      syncActiveVideoRef,
    ],
  );

  /**
   * Waits at the meeting point until the active deck's clock arrives, then
   * promotes. Never promotes because time passed — only because the readiness
   * rules were all satisfied at the same instant.
   */
  const awaitRendezvousAndPromote = useCallback(
    async (
      token: number,
      fromDeck: DeckId,
      toDeck: DeckId,
      commit: { toQualityId: string; url: string },
    ): Promise<SwitchOutcome> => {
      const activeElement = deckElementsRef.current[fromDeck];
      const standbyElement = deckElementsRef.current[toDeck];
      if (!activeElement || !standbyElement) return "failed";

      // Budget spent, counted only across ticks where the playhead actually
      // moved. A stalled deck therefore cannot burn it, and a playing deck that
      // never reaches the meeting point still runs out.
      let budgetSpentMs = 0;
      let lastTickAtMs = clock.now();
      let resyncsRemaining = MAX_RENDEZVOUS_RESYNCS;
      /**
       * Recent sampling intervals, in seconds of media the playhead covers per
       * check. Derived from monotonic wall time and the playback rate rather
       * than from observed position deltas, so it stays correct when the deck
       * is stalled (no movement, but the next tick still costs time) and when
       * playback is not at 1x.
       */
      const recentTickSeconds: number[] = [];
      /**
       * The wait has to be long enough to actually reach the meeting point.
       *
       * The standby parks ahead deliberately, and on a high-latency link the
       * adaptive lead can park it a long way ahead. Closing a gap of N seconds
       * takes N seconds of playback, so a fixed budget shorter than the gap
       * abandons a standby that is fully prepared and simply waiting — which is
       * exactly what stopped manual quality changes from ever landing.
       */
      const initialGapSeconds = Math.max(
        0,
        standbyElement.currentTime - activeElement.currentTime,
      );
      const budgetMs = Math.max(
        RENDEZVOUS_STALL_BUDGET_MS,
        (initialGapSeconds + 5) * 1_000,
      );
      const entryActivePosition = activeElement.currentTime;
      const recordWait = (
        outcome: RendezvousWaitRecord["outcome"],
      ): RendezvousWaitRecord => ({
        gapSecondsAtEntry: +initialGapSeconds.toFixed(3),
        budgetMs: Math.round(budgetMs),
        budgetSpentMs: Math.round(budgetSpentMs),
        activeAdvancedSeconds: +(
          activeElement.currentTime - entryActivePosition
        ).toFixed(3),
        gapSecondsAtExit: +(
          standbyElement.currentTime - activeElement.currentTime
        ).toFixed(3),
        outcome,
      });
      const publishWait = (outcome: RendezvousWaitRecord["outcome"]) => {
        dispatch({ type: "measure", token, rendezvous: recordWait(outcome) });
      };
      let lastActivePosition = activeElement.currentTime;

      for (;;) {
        if (isSuperseded(token)) {
          publishWait("superseded");
          return "superseded";
        }

        const activePosition = activeElement.currentTime;

        // A discontinuity in the active clock is a seek. The standby is parked
        // for a position the viewer has left, so this attempt is void.
        if (
          Math.abs(activePosition - lastActivePosition) > SEEK_DETECTION_SECONDS
        ) {
          cancelledTokensRef.current.add(token);
          publishWait("cancelled");
          dispatch({ type: "cancel", token, atMs: clock.now() });
          return "cancelled";
        }
        const tickAtMs = clock.now();
        const tickWallMs = tickAtMs - lastTickAtMs;
        if (activePosition !== lastActivePosition) {
          budgetSpentMs += tickWallMs;
        }
        // Media seconds this interval would cover at the current rate. Rate is
        // read live because the viewer can change it mid-wait.
        recentTickSeconds.push(
          (tickWallMs / 1_000) * (activeElement.playbackRate || 1),
        );
        if (recentTickSeconds.length > RENDEZVOUS_TICK_WINDOW) {
          recentTickSeconds.shift();
        }
        lastTickAtMs = tickAtMs;
        lastActivePosition = activePosition;

        const isActivePaused = activeElement.paused || activeElement.ended;
        const standbyPosition = standbyElement.currentTime;
        const readiness = evaluatePromotionReadiness({
          hasMetadata: standbyElement.readyState >= 1,
          durationSeconds: standbyElement.duration,
          readyState: standbyElement.readyState,
          bufferedAheadSeconds: bufferedAheadOf(
            asDeckMedia(standbyElement),
            standbyPosition,
          ),
          handoffPointSeconds: standbyPosition,
          hasDecodedFrame: true,
          superseded: false,
          failed: false,
          activePositionSeconds: activePosition,
          standbyPositionSeconds: standbyPosition,
          isActivePaused,
        });

        if (readiness.promotable) {
          // Eligible, but the meeting point may still be a few frames away.
          // While the standby is ahead and playback is closing the gap, waiting
          // costs a frame or two and buys back most of the drift allowance.
          if (
            !isActivePaused &&
            standbyPosition - activePosition > RENDEZVOUS_TARGET_SECONDS
          ) {
            await nextFrame();
            continue;
          }

          publishWait("promoted");
          dispatch({
            type: "handoff-start",
            token,
            atMs: clock.now(),
            driftAtHandoffSeconds: readiness.driftSeconds,
          });
          const promoted = await performHandoff(fromDeck, toDeck, commit);
          if (!promoted) return "failed";
          dispatch({ type: "promoted", token, atMs: clock.now() });
          watchForRollback(token, fromDeck, toDeck);
          return "promoted";
        }

        // The viewer paused while the standby was parked ahead. There is no
        // clock coming to meet it, so it moves back to the held frame instead
        // and promotes there, paused.
        if (isActivePaused && standbyPosition > activePosition) {
          publishWait("resynced");
          standbyElement.currentTime = activePosition;
          await nextFrame();
          await nextFrame();
          continue;
        }

        // The playhead has gone *past* the parked frame. This is the failure
        // that made switching impossible on a high-latency source: the meeting
        // point is chosen for a moment that has already been and gone, the
        // drift gate can never be satisfied again, and waiting only widens the
        // gap until the budget runs out — the recorded case exited 5.7s beyond
        // a standby it had been 16.9s short of.
        //
        // The playhead cannot be rewound, so the standby is re-aimed at it.
        // That region is already buffered from the original park, so this is an
        // in-buffer seek rather than another trip to the server.
        if (
          !isActivePaused &&
          activePosition - standbyPosition > MAX_HANDOFF_DRIFT_SECONDS &&
          resyncsRemaining > 0
        ) {
          resyncsRemaining -= 1;
          publishWait("resynced");
          // Aim far enough ahead that the next look cannot already be past it.
          const worstRecentTickSeconds = recentTickSeconds.length
            ? Math.max(...recentTickSeconds)
            : 0;
          const resyncLeadSeconds = Math.min(
            MAX_RENDEZVOUS_RESYNC_LEAD_SECONDS,
            Math.max(
              RENDEZVOUS_RESYNC_LEAD_SECONDS,
              worstRecentTickSeconds * RENDEZVOUS_RESYNC_TICK_MULTIPLE,
            ),
          );
          standbyElement.currentTime = activePosition + resyncLeadSeconds;
          // The re-aim lands inside the buffer the original park already
          // pulled, so this settles without another trip to the server. Waiting
          // for it keeps the next drift check honest.
          await waitForSeeked(standbyElement);
          continue;
        }

        if (budgetSpentMs > budgetMs) {
          publishWait("timed-out");
          dispatch({
            type: "fail",
            token,
            atMs: clock.now(),
            reason: "rendezvous-timeout",
          });
          return "failed";
        }

        // A timer, not a frame: this is a clock comparison and rAF is throttled
        // hard under decode load, which is what made the earlier re-aim lead
        // depend on scheduling luck.
        await delay(RENDEZVOUS_POLL_MS);
      }
    },
    [
      clock,
      delay,
      dispatch,
      isSuperseded,
      performHandoff,
      waitForSeeked,
      watchForRollback,
    ],
  );

  const requestSwitch = useCallback(
    async (request: SeamlessSwitchRequest): Promise<SwitchOutcome> => {
      const fromDeck = activeDeckIdRef.current;
      const toDeck = OTHER_DECK[fromDeck];
      const activeElement = deckElementsRef.current[fromDeck];
      const standbyElement = deckElementsRef.current[toDeck];

      if (!activeElement || !standbyElement) return "failed";

      const currentRequest = switchStateRef.current.request;
      if (
        currentRequest?.reason === "manual" &&
        isSwitchInFlight(switchStateRef.current) &&
        !request.isManual
      ) {
        // A periodic Auto review is advisory. It must never displace a quality
        // the viewer explicitly chose and is still waiting for.
        return "superseded";
      }

      // A switch already in flight is superseded rather than queued: only the
      // newest request may ever reach a promotion.
      // Only a switch that is still running can be superseded. One that already
      // promoted and settled has had its own record written, and writing a
      // second "superseded" one against it reports an outcome that never
      // happened.
      if (switchStateRef.current.request) {
        supersededTokensRef.current.add(switchStateRef.current.request.token);
        if (isSwitchInFlight(switchStateRef.current)) {
          emitDiagnostics("superseded");
        }
      }
      clearStabiliseTimer();

      tokenRef.current += 1;
      const token = tokenRef.current;
      const startedAtMs = clock.now();
      preparationOwnerRef.current[toDeck] = token;

      dispatch({
        type: "request",
        request: {
          token,
          reason: classifySwitchReason(
            request.fromHeight,
            request.toHeight,
            request.isManual,
          ),
          fromQualityId: request.fromQualityId,
          toQualityId: request.toQualityId,
          fromHeight: request.fromHeight,
          toHeight: request.toHeight,
          targetDeck: toDeck,
          startedAtMs,
        },
      });

      if (!isUnmountedRef.current) {
        setIsPreparing(true);
        setPendingQualityId(request.toQualityId);
      }

      const finish = (outcome: SwitchOutcome): SwitchOutcome => {
        if (tokenRef.current === token && !isUnmountedRef.current) {
          setIsPreparing(false);
          setPendingQualityId(null);
        }
        return outcome;
      };

      let result: SwitchOutcome;

      try {
        const prepared = await prepareStandbyDeck({
          standby: asDeckMedia(standbyElement),
          url: request.url,
          clock,
          readActive: () => ({
            positionSeconds: activeElement.currentTime,
            paused: activeElement.paused || activeElement.ended,
            playbackRate: activeElement.playbackRate,
          }),
          isSuperseded: () => isSuperseded(token),
          onProgress: (event) => {
            if (event.type === "metadata-ready") {
              dispatch({ type: "metadata-ready", token, atMs: event.atMs });
            } else if (event.type === "seek-complete") {
              dispatch({
                type: "seek-complete",
                token,
                atMs: event.atMs,
                handoffPointSeconds: event.handoffPointSeconds,
                rendezvousAttempts: event.rendezvousAttempts,
              });
            } else {
              dispatch({
                type: "frame-ready",
                token,
                atMs: event.atMs,
                bufferedAheadSeconds: event.bufferedAheadSeconds,
              });
            }
          },
          deadlineMs: request.isManual
            ? MANUAL_PREPARE_DEADLINE_MS
            : PREPARE_DEADLINE_MS,
        });

        dispatch({ type: "measure", token, attempts: prepared.attempts });

        if (prepared.outcome === "superseded") {
          // A superseded attempt has already been written up by the request
          // that displaced it; writing it up again here would report it
          // against the newer request's state.
          result = cancelledTokensRef.current.has(token)
            ? "cancelled"
            : "superseded";
          if (result === "cancelled") emitDiagnostics(result);
        } else if (prepared.outcome === "failed") {
          dispatch({
            type: "fail",
            token,
            atMs: clock.now(),
            reason: prepared.reason,
          });
          if (!request.isManual) {
            // Auto must not keep grinding at a rung that will not load.
            backoffRef.current.set(
              request.toQualityId,
              Date.now() + AUTO_RETRY_BACKOFF_MS,
            );
          }
          emitDiagnostics("failed");
          result = "failed";
        } else {
          result = await awaitRendezvousAndPromote(token, fromDeck, toDeck, {
            toQualityId: request.toQualityId,
            url: request.url,
          });
          if (result !== "promoted") {
            if (!request.isManual && result === "failed") {
              backoffRef.current.set(
                request.toQualityId,
                Date.now() + AUTO_RETRY_BACKOFF_MS,
              );
            }
            emitDiagnostics(result);
          }
        }
      } catch {
        dispatch({
          type: "fail",
          token,
          atMs: clock.now(),
          reason: "unexpected-error",
        });
        emitDiagnostics("failed");
        result = "failed";
      }

      // Whatever happened, the deck that did not win is returned to a clean
      // state — but never the retained one, which rollback may still need.
      if (result !== "promoted") {
        const abandoned = deckElementsRef.current[toDeck];
        if (
          preparationOwnerRef.current[toDeck] === token &&
          abandoned &&
          abandoned !== retainedDeckRef.current &&
          toDeck !== activeDeckIdRef.current
        ) {
          releaseDeck(asDeckMedia(abandoned));
        }
        if (tokenRef.current === token) {
          dispatch({ type: "reset" });
        }
      }

      if (preparationOwnerRef.current[toDeck] === token) {
        preparationOwnerRef.current[toDeck] = null;
      }

      return finish(result);
    },
    [
      awaitRendezvousAndPromote,
      clearStabiliseTimer,
      clock,
      dispatch,
      emitDiagnostics,
      isSuperseded,
    ],
  );

  useEffect(() => {
    isUnmountedRef.current = false;

    return () => {
      // Unmount cancels anything in flight and releases both sources; a
      // preparation left running would keep pulling a rendition for a player
      // that no longer exists.
      isUnmountedRef.current = true;
      const inFlight = switchStateRef.current.request;
      // Reading these refs at teardown time is the intent, not a mistake: the
      // decks and the in-flight token as they stand *now* are exactly what has
      // to be cancelled and released.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
      if (inFlight) cancelledTokensRef.current.add(inFlight.token);
      if (stabiliseTimerRef.current !== null) {
        clock.clearTimeout(stabiliseTimerRef.current);
        stabiliseTimerRef.current = null;
      }
      retainedDeckRef.current = null;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
      const decks = deckElementsRef.current;
      (["a", "b"] as const).forEach((deckId) => {
        const element = decks[deckId];
        if (element) releaseDeck(asDeckMedia(element));
      });
    };
  }, [clock]);

  return {
    videoRef,
    activeDeckId,
    standbyDeckId: OTHER_DECK[activeDeckId],
    deckEpoch,
    setDeckElement,
    deckRefs,
    getDeckElement,
    isActiveDeckElement,
    requestSwitch,
    cancelSwitch,
    notifyActiveSeek,
    isPreparing,
    pendingQualityId,
    isRetainedDeckElement,
    isBackedOff,
    switchState,
  };
}
