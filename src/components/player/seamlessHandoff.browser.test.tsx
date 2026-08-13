/**
 * The handoff, in a real browser, against two real renditions.
 *
 * Everything the unit tests assert is about sequencing. This asserts the thing
 * the viewer actually complained about: that the clock does not go backwards,
 * the picture does not go black, and playback does not stop. None of that can
 * be observed in jsdom, which has no decoder.
 */

import { act, cleanup, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { SwitchDiagnostics, SwitchOutcome } from "./deckModel";
import {
  useSeamlessQualitySwitch,
  type PlaybackIntent,
  type SeamlessQualitySwitchApi,
  type SeamlessSwitchRequest,
} from "./useSeamlessQualitySwitch";

const SOURCES = {
  q720: "/test-media/720p.mp4",
  q1080: "/test-media/1080p.mp4",
} as const;

const FIXTURE_DURATION_SECONDS = 10;
/** Where the switch is asked for, far enough in to be mid-playback. */
const SWITCH_AT_SECONDS = 2;

interface Sample {
  atMs: number;
  displayedTime: number;
  duration: number;
  activeDeck: string;
  isVisibleFramePainted: boolean;
}

interface Recording {
  samples: Sample[];
  pauseEvents: number;
  waitingEvents: number;
  emptiedEvents: number;
  diagnostics: SwitchDiagnostics[];
}

/**
 * Mirrors how the player mounts the pair: both decks full size in the same
 * box, only opacity and stacking deciding which decoded frame is on screen.
 */
function DeckHarness({
  onReady,
  recording,
}: {
  onReady: (api: DeckApi) => void;
  recording: Recording;
}) {
  const [, setPromotions] = useState(0);
  // The accessors and the intent reader both have to see the *current*
  // render's controller. Capturing `deck` once would freeze `activeDeckId` at
  // whatever it was when the harness mounted, which is precisely the value a
  // promotion changes.
  const deckApiRef = useRef<SeamlessQualitySwitchApi | null>(null);

  const deck = useSeamlessQualitySwitch({
    // Read live from the active deck, exactly as the player does, so what the
    // viewer has actually done to volume, rate and play state is what the
    // handoff carries over.
    readIntent: (): PlaybackIntent => {
      const video = deckApiRef.current?.videoRef.current ?? null;
      return {
        volume: video?.volume ?? 1,
        muted: video?.muted ?? true,
        playbackRate: video?.playbackRate ?? 1,
        wantsToPlay: video ? !video.paused && !video.ended : false,
      };
    },
    onPromoted: () => setPromotions((count) => count + 1),
    onDiagnostics: (entry) => recording.diagnostics.push(entry),
    stabiliseMs: 800,
  });

  deckApiRef.current = deck;

  const hasNotifiedRef = useRef(false);
  if (!hasNotifiedRef.current) {
    hasNotifiedRef.current = true;
    onReady({
      requestSwitch: (request) => deckApiRef.current!.requestSwitch(request),
      getActiveVideo: () => deckApiRef.current?.videoRef.current ?? null,
      getActiveDeckId: () => deckApiRef.current?.activeDeckId ?? "a",
    });
  }

  return (
    <div
      data-testid="viewport"
      style={{
        position: "relative",
        width: 640,
        height: 360,
        background: "black",
        overflow: "hidden",
      }}
    >
      {(["a", "b"] as const).map((deckId) => {
        const isActive = deckId === deck.activeDeckId;

        return (
          <video
            key={deckId}
            data-deck={deckId}
            data-deck-role={isActive ? "active" : "standby"}
            ref={deck.deckRefs[deckId]}
            playsInline
            muted
            preload="auto"
            crossOrigin="anonymous"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
              zIndex: isActive ? 2 : 1,
              opacity: isActive ? 1 : 0,
              pointerEvents: isActive ? undefined : "none",
            }}
            onPause={(event) => {
              if (!deck.isActiveDeckElement(event.currentTarget)) return;
              recording.pauseEvents += 1;
            }}
            onWaiting={(event) => {
              if (!deck.isActiveDeckElement(event.currentTarget)) return;
              recording.waitingEvents += 1;
            }}
            onEmptied={(event) => {
              if (!deck.isActiveDeckElement(event.currentTarget)) return;
              recording.emptiedEvents += 1;
            }}
          />
        );
      })}
    </div>
  );
}

/** True when the visible deck is painting something other than a black frame. */
function isFramePainted(video: HTMLVideoElement | null): boolean {
  if (!video || video.videoWidth === 0) return false;

  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 27;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return false;

  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let total = 0;
    for (let index = 0; index < data.length; index += 4) {
      total += data[index] + data[index + 1] + data[index + 2];
    }
    // `testsrc` is a bright colour-bar pattern, so anything genuinely decoded
    // is far above this. A blanked element reads as a flat zero.
    return total / (data.length / 4) > 12;
  } catch {
    return false;
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (performance.now() - startedAt > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

interface DeckApi {
  requestSwitch: (request: SeamlessSwitchRequest) => Promise<SwitchOutcome>;
  getActiveVideo: () => HTMLVideoElement | null;
  getActiveDeckId: () => string;
}

interface Harness {
  recording: Recording;
  requestSwitch: (request: SeamlessSwitchRequest) => Promise<SwitchOutcome>;
  getActiveVideo: () => HTMLVideoElement | null;
  getActiveDeckId: () => string;
  startSampling: () => () => void;
}

async function mountPlayingAt720p(): Promise<Harness> {
  const recording: Recording = {
    samples: [],
    pauseEvents: 0,
    waitingEvents: 0,
    emptiedEvents: 0,
    diagnostics: [],
  };

  // Held on a property rather than in a local, so the assignment inside the
  // render callback is visible to the type checker.
  const holder: { api: DeckApi | null } = { api: null };

  await act(async () => {
    render(
      <DeckHarness
        recording={recording}
        onReady={(ready) => {
          holder.api = ready;
        }}
      />,
    );
  });

  const ready = holder.api;
  if (!ready) throw new Error("The deck harness never reported ready");

  const active = ready.getActiveVideo();
  if (!active) throw new Error("The active deck never mounted");

  // Bring the active deck up on 720p the way the player would, then let it run
  // to the point the switch is asked for.
  active.src = SOURCES.q720;
  active.load();
  await waitFor(() => active.readyState >= 1 && active.duration > 0);
  await active.play();
  await waitFor(() => active.currentTime >= SWITCH_AT_SECONDS);

  // Bringing the deck up is the harness's own doing — `load()` always emits
  // `emptied`. Only what happens from the switch onwards is under test.
  recording.pauseEvents = 0;
  recording.waitingEvents = 0;
  recording.emptiedEvents = 0;

  const startSampling = () => {
    let stopped = false;
    const sample = () => {
      if (stopped) return;
      const video = ready.getActiveVideo();
      recording.samples.push({
        atMs: performance.now(),
        displayedTime: video?.currentTime ?? Number.NaN,
        duration: video?.duration ?? Number.NaN,
        activeDeck: ready.getActiveDeckId(),
        isVisibleFramePainted: isFramePainted(video),
      });
      requestAnimationFrame(sample);
    };
    sample();
    return () => {
      stopped = true;
    };
  };

  return { recording, startSampling, ...ready };
}

/** Puts the recorded diagnostics into the assertion message. */
function describeOutcome(harness: Harness): string {
  return `diagnostics: ${JSON.stringify(harness.recording.diagnostics)}`;
}

/** Largest backwards step in the displayed clock across the recording. */
function maxTimelineDiscontinuity(samples: Sample[]): number {
  let worst = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const delta =
      samples[index].displayedTime - samples[index - 1].displayedTime;
    if (delta < 0) worst = Math.max(worst, -delta);
  }
  return worst;
}

afterEach(() => {
  cleanup();
});

describe("seamless rendition handoff in a real browser", () => {
  it("hands 720p over to 1080p without a black frame, a reload or a paused clock", async () => {
    const harness = await mountPlayingAt720p();
    const stopSampling = harness.startSampling();

    const deckBefore = harness.getActiveDeckId();
    const durationBefore = harness.getActiveVideo()?.duration ?? 0;
    const timeBefore = harness.getActiveVideo()?.currentTime ?? 0;

    const outcome = await harness.requestSwitch({
      url: SOURCES.q1080,
      toQualityId: "q1080",
      toHeight: 1080,
      fromQualityId: "q720",
      fromHeight: 720,
      isManual: true,
    });

    // Keep sampling until the switch has fully settled, so the frames after the
    // swap are recorded too and the written-up record exists to assert on.
    await waitFor(() =>
      harness.recording.diagnostics.some(
        (entry) => entry.outcome === "promoted",
      ),
    );
    stopSampling();

    const { samples } = harness.recording;
    const active = harness.getActiveVideo();

    expect(outcome, describeOutcome(harness)).toBe("promoted");

    // The prepared deck is the one now playing, and it is the other one.
    expect(harness.getActiveDeckId()).not.toBe(deckBefore);
    expect(active?.videoHeight).toBe(1080);
    expect(active?.currentSrc).toContain("1080p.mp4");

    // The clock never restarted and never showed an empty timeline.
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.every((entry) => entry.displayedTime > 0)).toBe(true);
    expect(samples.every((entry) => entry.duration > 0)).toBe(true);
    expect(
      samples.every(
        (entry) => Math.abs(entry.duration - FIXTURE_DURATION_SECONDS) < 0.5,
      ),
    ).toBe(true);
    expect(durationBefore).toBeGreaterThan(0);
    expect(samples.at(-1)!.displayedTime).toBeGreaterThan(timeBefore);

    // No visible interruption: no user-facing pause, no buffering wait caused
    // by the change, and no element ever emptied under the viewer.
    expect(harness.recording.pauseEvents).toBe(0);
    expect(harness.recording.emptiedEvents).toBe(0);
    expect(harness.recording.waitingEvents).toBe(0);
    expect(active?.paused).toBe(false);

    // A decoded frame was on screen for every sample taken.
    const blankSamples = samples.filter(
      (entry) => !entry.isVisibleFramePainted,
    );
    expect(blankSamples).toHaveLength(0);

    const discontinuity = maxTimelineDiscontinuity(samples);
    console.info("[handoff] max timeline discontinuity (s):", discontinuity);
    expect(discontinuity).toBeLessThanOrEqual(0.25);

    const promoted = harness.recording.diagnostics.find(
      (entry) => entry.outcome === "promoted",
    );
    console.info("[handoff] diagnostics:", JSON.stringify(promoted));
    expect(promoted).toBeDefined();
    expect(promoted!.driftAtHandoffSeconds).toBeTypeOf("number");
    expect(promoted!.driftAtHandoffSeconds).toBeLessThanOrEqual(0.25);
    expect(promoted!.bufferedSecondsAhead).toBeGreaterThanOrEqual(2);
  });

  it("hands 1080p back down to 720p the same way", async () => {
    const harness = await mountPlayingAt720p();

    await harness.requestSwitch({
      url: SOURCES.q1080,
      toQualityId: "q1080",
      toHeight: 1080,
      fromQualityId: "q720",
      fromHeight: 720,
      isManual: true,
    });
    await waitFor(() => harness.getActiveVideo()?.videoHeight === 1080);
    // Let the promoted deck stabilise so the other one is free to prepare.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const stopSampling = harness.startSampling();
    const deckBefore = harness.getActiveDeckId();

    // The Auto downgrade uses exactly the same handoff as the upgrade.
    const outcome = await harness.requestSwitch({
      url: SOURCES.q720,
      toQualityId: "q720",
      toHeight: 720,
      fromQualityId: "q1080",
      fromHeight: 1080,
      isManual: false,
    });

    // The promoted record is written when the switch settles, which is after
    // the rollback window closes.
    await waitFor(() =>
      harness.recording.diagnostics.some(
        (entry) => entry.toQualityId === "q720" && entry.outcome === "promoted",
      ),
    );
    stopSampling();

    expect(outcome, describeOutcome(harness)).toBe("promoted");
    expect(harness.getActiveDeckId()).not.toBe(deckBefore);
    expect(harness.getActiveVideo()?.videoHeight).toBe(720);
    expect(harness.recording.pauseEvents).toBe(0);
    expect(harness.recording.emptiedEvents).toBe(0);

    const samples = harness.recording.samples;
    expect(samples.every((entry) => entry.isVisibleFramePainted)).toBe(true);
    expect(maxTimelineDiscontinuity(samples)).toBeLessThanOrEqual(0.25);

    const downgrade = harness.recording.diagnostics.find(
      (entry) => entry.toQualityId === "q720" && entry.outcome === "promoted",
    );
    expect(downgrade?.reason).toBe("auto-downgrade");
  });

  it("keeps the current rendition playing when the target cannot be loaded", async () => {
    const harness = await mountPlayingAt720p();
    const stopSampling = harness.startSampling();
    const deckBefore = harness.getActiveDeckId();

    const outcome = await harness.requestSwitch({
      url: "/test-media/does-not-exist.mp4",
      toQualityId: "q1080",
      toHeight: 1080,
      fromQualityId: "q720",
      fromHeight: 720,
      isManual: false,
    });

    stopSampling();
    const active = harness.getActiveVideo();

    expect(outcome, describeOutcome(harness)).toBe("failed");
    // Nothing moved. The viewer is still on 720p, still playing, still looking
    // at a picture — which is the entire point of not falling back to the
    // destructive path.
    expect(harness.getActiveDeckId()).toBe(deckBefore);
    expect(active?.videoHeight).toBe(720);
    expect(active?.paused).toBe(false);
    expect(harness.recording.pauseEvents).toBe(0);
    expect(harness.recording.emptiedEvents).toBe(0);
    expect(
      harness.recording.samples.every((entry) => entry.isVisibleFramePainted),
    ).toBe(true);
  });

  it("promotes paused, holding the viewer's frame, when playback is paused", async () => {
    const harness = await mountPlayingAt720p();
    const active = harness.getActiveVideo();
    if (!active) throw new Error("no active deck");

    active.pause();
    await waitFor(() => active.paused);
    // `pause` is queued rather than dispatched inline, so the harness's own
    // pause has to be allowed to land before it is counted as the baseline.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pausedAt = active.currentTime;
    const pausesBefore = harness.recording.pauseEvents;

    const outcome = await harness.requestSwitch({
      url: SOURCES.q1080,
      toQualityId: "q1080",
      toHeight: 1080,
      fromQualityId: "q720",
      fromHeight: 720,
      isManual: true,
    });

    const promoted = harness.getActiveVideo();

    expect(outcome, describeOutcome(harness)).toBe("promoted");
    expect(promoted?.videoHeight).toBe(1080);
    // Still paused, on the same frame, and the outgoing deck's pause was not
    // reported as the viewer's.
    expect(promoted?.paused).toBe(true);
    expect(
      Math.abs((promoted?.currentTime ?? 0) - pausedAt),
    ).toBeLessThanOrEqual(0.25);
    expect(harness.recording.pauseEvents).toBe(pausesBefore);
    expect(isFramePainted(promoted)).toBe(true);
  });

  it("carries volume, mute and a non-1x rate across the handoff", async () => {
    const harness = await mountPlayingAt720p();
    const before = harness.getActiveVideo();
    if (!before) throw new Error("no active deck");

    before.playbackRate = 1.5;

    const outcome = await harness.requestSwitch({
      url: SOURCES.q1080,
      toQualityId: "q1080",
      toHeight: 1080,
      fromQualityId: "q720",
      fromHeight: 720,
      isManual: true,
    });

    const after = harness.getActiveVideo();

    expect(outcome, describeOutcome(harness)).toBe("promoted");
    expect(after?.playbackRate).toBeCloseTo(1.5, 5);
    expect(after?.muted).toBe(true);
    expect(after?.volume).toBeCloseTo(1, 5);
    // Only one deck may be audible, and the outgoing one gave audio up.
    expect(before.muted).toBe(true);
  });

  it("keeps a manual handoff alive when Auto reviews during preparation", async () => {
    const harness = await mountPlayingAt720p();
    const stopSampling = harness.startSampling();

    // Start the viewer's pick, then simulate an Auto review in the same turn —
    // before React has even had a chance to render the preparing state. This is
    // the narrow race that used to supersede the manual request. Its late
    // cleanup could then pause and clear the deck the replacement promoted.
    const manual = harness.requestSwitch({
      url: SOURCES.q1080,
      toQualityId: "q1080-manual",
      toHeight: 1080,
      fromQualityId: "q720",
      fromHeight: 720,
      isManual: true,
    });
    const auto = await harness.requestSwitch({
      url: SOURCES.q720,
      toQualityId: "q720-auto",
      toHeight: 720,
      fromQualityId: "q720",
      fromHeight: 720,
      isManual: false,
    });
    const manualOutcome = await manual;

    await waitFor(() => harness.getActiveVideo()?.videoHeight === 1080);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    stopSampling();

    const active = harness.getActiveVideo();
    expect(auto).toBe("superseded");
    expect(manualOutcome, describeOutcome(harness)).toBe("promoted");
    expect(active?.currentSrc).toContain("1080p.mp4");
    expect(active?.paused).toBe(false);
    expect(harness.recording.pauseEvents).toBe(0);
    expect(harness.recording.emptiedEvents).toBe(0);
    expect(harness.recording.samples.every((entry) => entry.duration > 0)).toBe(
      true,
    );
    expect(
      harness.recording.samples.every((entry) => entry.isVisibleFramePainted),
    ).toBe(true);
  });
});
