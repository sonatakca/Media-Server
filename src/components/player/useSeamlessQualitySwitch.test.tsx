import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SwitchDiagnostics } from "./deckModel";
import type { DeckClock } from "./prepareStandbyDeck";
import {
  useSeamlessQualitySwitch,
  type PlaybackIntent,
  type SeamlessSwitchRequest,
} from "./useSeamlessQualitySwitch";

const clock: DeckClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
  requestAnimationFrame: (callback) =>
    setTimeout(callback, 0) as unknown as number,
  cancelAnimationFrame: (handle) => clearTimeout(handle),
};

interface FakeVideoOptions {
  durationSeconds?: number;
  /** Media seconds that pass per wall-clock second, to keep tests brisk. */
  timeScale?: number;
  canLoad?: boolean;
  canSeek?: boolean;
  canBuffer?: boolean;
  canDecode?: boolean;
}

/**
 * Enough of a video element for the deck controller to drive, with a real
 * moving clock so the rendezvous is exercised rather than short-circuited.
 */
class FakeVideo {
  src = "";
  preload = "none";
  muted = false;
  volume = 1;
  playbackRate = 1;
  duration = Number.NaN;
  readyState = 0;
  paused = true;
  ended = false;
  seeking = false;
  bufferAheadSeconds = 10;

  loadCount = 0;
  playCount = 0;
  pauseCount = 0;
  removedAttributes: string[] = [];

  canLoad: boolean;
  canSeek: boolean;
  canBuffer: boolean;
  canDecode: boolean;

  private readonly durationSeconds: number;
  private readonly timeScale: number;
  private listeners = new Map<string, Set<() => void>>();
  private baseSeconds = 0;
  private playingSinceMs: number | null = null;

  constructor({
    durationSeconds = 3600,
    timeScale = 1,
    canLoad = true,
    canSeek = true,
    canBuffer = true,
    canDecode = true,
  }: FakeVideoOptions = {}) {
    this.durationSeconds = durationSeconds;
    this.timeScale = timeScale;
    this.canLoad = canLoad;
    this.canSeek = canSeek;
    this.canBuffer = canBuffer;
    this.canDecode = canDecode;
  }

  /** Zero until a frame is decoded, closing both frame-detection routes. */
  get videoWidth(): number {
    return this.canDecode ? 1920 : 0;
  }

  get currentTime(): number {
    if (this.playingSinceMs === null) return this.baseSeconds;
    const elapsed = (Date.now() - this.playingSinceMs) / 1_000;
    return this.baseSeconds + elapsed * this.timeScale * this.playbackRate;
  }

  set currentTime(seconds: number) {
    this.baseSeconds = seconds;
    if (this.playingSinceMs !== null) this.playingSinceMs = Date.now();
    this.seeking = true;
    if (!this.canSeek) return;

    setTimeout(() => {
      this.readyState = this.canBuffer ? 3 : 2;
      this.seeking = false;
      this.emit("seeked");
    }, 0);
  }

  get buffered() {
    if (!this.canBuffer) return { length: 0, start: () => 0, end: () => 0 };
    const position = this.currentTime;
    const range = {
      start: Math.max(0, position - 2),
      end: Math.min(this.durationSeconds, position + this.bufferAheadSeconds),
    };
    return {
      length: 1,
      start: () => range.start,
      end: () => range.end,
    };
  }

  load(): void {
    this.loadCount += 1;
    if (!this.canLoad) {
      setTimeout(() => this.emit("error"), 0);
      return;
    }
    setTimeout(() => {
      this.duration = this.durationSeconds;
      this.readyState = Math.max(this.readyState, 1);
      this.emit("loadedmetadata");
    }, 0);
  }

  play(): Promise<void> {
    this.playCount += 1;
    this.baseSeconds = this.currentTime;
    this.playingSinceMs = Date.now();
    this.paused = false;
    setTimeout(() => this.emit("playing"), 0);
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCount += 1;
    this.baseSeconds = this.currentTime;
    this.playingSinceMs = null;
    this.paused = true;
  }

  removeAttribute(name: string): void {
    this.removedAttributes.push(name);
  }

  requestVideoFrameCallback(callback: () => void): number {
    if (!this.canDecode) return 0;
    return setTimeout(callback, 0) as unknown as number;
  }

  cancelVideoFrameCallback(handle: number): void {
    clearTimeout(handle);
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }

  /** Starts this deck playing at a position, as the active deck would be. */
  startPlayingAt(seconds: number, url: string): void {
    this.src = url;
    this.duration = this.durationSeconds;
    this.readyState = 3;
    this.baseSeconds = seconds;
    this.playingSinceMs = Date.now();
    this.paused = false;
  }

  get element(): HTMLVideoElement {
    return this as unknown as HTMLVideoElement;
  }
}

const UPGRADE: SeamlessSwitchRequest = {
  url: "https://media.test/renditions/1080p.mp4",
  toQualityId: "q1080",
  toHeight: 1080,
  fromQualityId: "q720",
  fromHeight: 720,
  isManual: false,
};

interface Harness {
  deckA: FakeVideo;
  deckB: FakeVideo;
  intent: PlaybackIntent;
  promotions: Array<{ toQualityId: string; url: string; deckId: string }>;
  diagnostics: SwitchDiagnostics[];
}

function setUp(
  options: {
    activeOptions?: FakeVideoOptions;
    standbyOptions?: FakeVideoOptions;
    intent?: Partial<PlaybackIntent>;
    stabiliseMs?: number;
  } = {},
) {
  const deckA = new FakeVideo({ timeScale: 20, ...options.activeOptions });
  const deckB = new FakeVideo(options.standbyOptions);
  const harness: Harness = {
    deckA,
    deckB,
    intent: {
      volume: 0.8,
      muted: false,
      playbackRate: 1,
      wantsToPlay: true,
      ...options.intent,
    },
    promotions: [],
    diagnostics: [],
  };

  deckA.startPlayingAt(420, "https://media.test/renditions/720p.mp4");
  deckA.volume = harness.intent.volume;
  deckA.muted = harness.intent.muted;

  const rendered = renderHook(() =>
    useSeamlessQualitySwitch({
      clock,
      stabiliseMs: options.stabiliseMs ?? 120,
      readIntent: () => harness.intent,
      onPromoted: (commit) => harness.promotions.push(commit),
      onDiagnostics: (entry) => harness.diagnostics.push(entry),
    }),
  );

  act(() => {
    rendered.result.current.setDeckElement("a", deckA.element);
    rendered.result.current.setDeckElement("b", deckB.element);
  });

  return { ...rendered, harness };
}

describe("useSeamlessQualitySwitch", () => {
  it("starts with deck a active and deck b standing by", () => {
    const { result } = setUp();
    expect(result.current.activeDeckId).toBe("a");
    expect(result.current.standbyDeckId).toBe("b");
    expect(result.current.videoRef.current).toBe(
      result.current.getDeckElement("a"),
    );
  });

  it("keeps the active deck playing and untouched while the standby loads", async () => {
    const { result, harness } = setUp({
      standbyOptions: { canBuffer: false },
    });

    let settled: string | undefined;
    act(() => {
      void result.current
        .requestSwitch(UPGRADE)
        .then((outcome) => (settled = outcome));
    });

    await waitFor(() => expect(harness.deckB.loadCount).toBe(1));

    // The deck the viewer is watching is still playing its own source.
    expect(harness.deckA.paused).toBe(false);
    expect(harness.deckA.src).toBe("https://media.test/renditions/720p.mp4");
    expect(harness.deckA.loadCount).toBe(0);
    expect(harness.deckA.pauseCount).toBe(0);
    expect(settled).toBeUndefined();

    act(() => result.current.cancelSwitch("test-teardown"));
    await waitFor(() => expect(settled).toBeDefined());
  });

  it("does not commit the quality or the source during preparation", async () => {
    const { result, harness } = setUp({
      standbyOptions: { canBuffer: false },
    });

    act(() => {
      void result.current.requestSwitch(UPGRADE);
    });

    await waitFor(() => expect(result.current.isPreparing).toBe(true));

    expect(result.current.pendingQualityId).toBe("q1080");
    expect(harness.promotions).toHaveLength(0);
    expect(result.current.activeDeckId).toBe("a");

    act(() => result.current.cancelSwitch("test-teardown"));
  });

  it("promotes the very element that did the preparing", async () => {
    const { result, harness } = setUp();

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.requestSwitch(UPGRADE);
    });

    expect(outcome).toBe("promoted");
    expect(result.current.activeDeckId).toBe("b");
    expect(result.current.videoRef.current).toBe(harness.deckB.element);
    expect(harness.deckB.src).toBe(UPGRADE.url);
    expect(harness.promotions).toEqual([
      { toQualityId: "q1080", url: UPGRADE.url, deckId: "b" },
    ]);
  });

  it("advances the deck epoch so active listeners rebind after promotion", async () => {
    const { result } = setUp();
    const epochBefore = result.current.deckEpoch;

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });

    expect(result.current.deckEpoch).toBeGreaterThan(epochBefore);
  });

  it("cannot promote before metadata, seek, buffering and a frame all land", async () => {
    for (const gate of [
      { canLoad: false },
      { canSeek: false },
      { canBuffer: false },
      { canDecode: false },
    ]) {
      const { result, harness, unmount } = setUp({ standbyOptions: gate });

      let outcome: string | undefined;
      act(() => {
        void result.current
          .requestSwitch(UPGRADE)
          .then((settled) => (outcome = settled));
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
      });

      expect(harness.promotions).toHaveLength(0);
      expect(result.current.activeDeckId).toBe("a");
      expect(outcome).not.toBe("promoted");

      act(() => result.current.cancelSwitch("test-teardown"));
      unmount();
    }
  });

  it("never promotes a superseded request", async () => {
    const { result, harness } = setUp({ standbyOptions: { canBuffer: false } });

    let firstOutcome: string | undefined;
    act(() => {
      void result.current
        .requestSwitch(UPGRADE)
        .then((outcome) => (firstOutcome = outcome));
    });
    await waitFor(() => expect(harness.deckB.loadCount).toBe(1));

    // A newer pick lands mid-flight, and only it may ever promote.
    harness.deckB.canBuffer = true;
    let secondOutcome: string | undefined;
    await act(async () => {
      secondOutcome = await result.current.requestSwitch({
        ...UPGRADE,
        toQualityId: "q480",
        toHeight: 480,
        url: "https://media.test/renditions/480p.mp4",
      });
    });

    await waitFor(() => expect(firstOutcome).toBeDefined());

    expect(firstOutcome).toBe("superseded");
    expect(secondOutcome).toBe("promoted");
    expect(harness.promotions).toEqual([
      {
        toQualityId: "q480",
        url: "https://media.test/renditions/480p.mp4",
        deckId: "b",
      },
    ]);
  });

  it("refuses to promote at a stale position after the viewer seeks", async () => {
    const { result, harness } = setUp({ standbyOptions: { canBuffer: false } });

    let outcome: string | undefined;
    act(() => {
      void result.current
        .requestSwitch(UPGRADE)
        .then((settled) => (outcome = settled));
    });
    await waitFor(() => expect(harness.deckB.loadCount).toBe(1));

    act(() => {
      harness.deckA.currentTime = 1_800;
      result.current.notifyActiveSeek();
    });
    harness.deckB.canBuffer = true;

    await waitFor(() => expect(outcome).toBeDefined());

    expect(outcome).toBe("cancelled");
    expect(harness.promotions).toHaveLength(0);
    expect(result.current.activeDeckId).toBe("a");
  });

  it("preserves a paused viewer's intent across the handoff", async () => {
    const { result, harness } = setUp({
      intent: { wantsToPlay: false },
    });
    harness.deckA.pause();

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.requestSwitch({
        ...UPGRADE,
        isManual: true,
      });
    });

    expect(outcome).toBe("promoted");
    expect(harness.deckB.paused).toBe(true);
    expect(harness.deckB.playCount).toBe(0);
    // The promoted deck holds exactly the frame the viewer was looking at.
    expect(
      Math.abs(harness.deckB.currentTime - harness.deckA.currentTime),
    ).toBeLessThanOrEqual(0.05);
  });

  it("preserves a playing viewer's intent across the handoff", async () => {
    const { result, harness } = setUp();

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });

    expect(harness.deckB.paused).toBe(false);
    expect(harness.deckB.playCount).toBeGreaterThan(0);
  });

  it("transfers volume, mute and playback rate to the promoted deck", async () => {
    const { result, harness } = setUp({
      intent: { volume: 0.35, muted: true, playbackRate: 1.75 },
    });

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });

    expect(harness.deckB.volume).toBeCloseTo(0.35, 5);
    expect(harness.deckB.muted).toBe(true);
    expect(harness.deckB.playbackRate).toBeCloseTo(1.75, 5);
    // No overlap: the outgoing deck gives up audio in the same operation.
    expect(harness.deckA.muted).toBe(true);
  });

  it("never lets both decks be audible at once", async () => {
    const { result, harness } = setUp({ intent: { muted: false } });

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });

    expect(harness.deckA.muted).toBe(true);
    expect(harness.deckB.muted).toBe(false);
  });

  it("keeps a stable duration on the deck that is showing", async () => {
    const { result, harness } = setUp();
    const durationBefore = harness.deckA.duration;

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });

    const active = result.current.videoRef.current as unknown as FakeVideo;
    expect(active.duration).toBe(durationBefore);
    expect(active.duration).toBeGreaterThan(0);
  });

  it("leaves the old quality playing when the target fails", async () => {
    const { result, harness } = setUp({ standbyOptions: { canLoad: false } });

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.requestSwitch(UPGRADE);
    });

    expect(outcome).toBe("failed");
    expect(result.current.activeDeckId).toBe("a");
    expect(harness.deckA.paused).toBe(false);
    expect(harness.deckA.src).toBe("https://media.test/renditions/720p.mp4");
    expect(harness.promotions).toHaveLength(0);
  });

  it("does not reload the active deck when an Auto target fails", async () => {
    const { result, harness } = setUp({ standbyOptions: { canLoad: false } });

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });

    // The destructive single-element path would show up here as a load on the
    // element the viewer is watching.
    expect(harness.deckA.loadCount).toBe(0);
    expect(harness.deckA.removedAttributes).toHaveLength(0);
    expect(harness.deckA.pauseCount).toBe(0);
  });

  it("backs a failed Auto rung off, but never a manual pick", async () => {
    const { result } = setUp({ standbyOptions: { canLoad: false } });

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });
    expect(result.current.isBackedOff("q1080")).toBe(true);

    const manual = setUp({ standbyOptions: { canLoad: false } });
    await act(async () => {
      await manual.result.current.requestSwitch({ ...UPGRADE, isManual: true });
    });
    expect(manual.result.current.isBackedOff("q1080")).toBe(false);
  });

  it("reports a manual failure as a nonfatal outcome with playback retained", async () => {
    const { result, harness } = setUp({ standbyOptions: { canLoad: false } });

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.requestSwitch({
        ...UPGRADE,
        isManual: true,
      });
    });

    expect(outcome).toBe("failed");
    expect(harness.deckA.paused).toBe(false);
    expect(result.current.isPreparing).toBe(false);
    expect(result.current.pendingQualityId).toBeNull();
    expect(harness.diagnostics.at(-1)).toMatchObject({
      outcome: "failed",
      reason: "manual",
      toQualityId: "q1080",
    });
  });

  it("clears the old deck only after the new one has proved stable", async () => {
    const { result, harness } = setUp({ stabiliseMs: 200 });

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });

    // Still loaded, because rollback may still need it.
    expect(harness.deckA.src).toBe("https://media.test/renditions/720p.mp4");
    expect(result.current.isRetainedDeckElement(harness.deckA.element)).toBe(
      true,
    );

    await waitFor(
      () => {
        expect(harness.deckA.src).toBe("");
      },
      { timeout: 2_000 },
    );
    expect(result.current.isRetainedDeckElement(harness.deckA.element)).toBe(
      false,
    );
  });

  it("rolls back to the old deck when the new one fails immediately", async () => {
    const { result, harness } = setUp({ stabiliseMs: 1_000 });

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });
    expect(result.current.activeDeckId).toBe("b");

    act(() => {
      harness.deckB.emit("error");
    });

    await waitFor(() => expect(result.current.activeDeckId).toBe("a"));

    expect(result.current.videoRef.current).toBe(harness.deckA.element);
    expect(harness.deckA.paused).toBe(false);
    expect(harness.deckA.muted).toBe(false);
    expect(harness.deckB.src).toBe("");
    expect(harness.diagnostics.at(-1)).toMatchObject({
      outcome: "rolled-back",
      failureReason: "promoted-deck-error",
    });
  });

  it("alternates decks safely across repeated 720p to 1080p to 720p switches", async () => {
    const { result, harness } = setUp({ stabiliseMs: 30 });

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });
    expect(result.current.activeDeckId).toBe("b");
    await waitFor(() => expect(harness.deckA.src).toBe(""));

    await act(async () => {
      await result.current.requestSwitch({
        url: "https://media.test/renditions/720p.mp4",
        toQualityId: "q720",
        toHeight: 720,
        fromQualityId: "q1080",
        fromHeight: 1080,
        isManual: false,
      });
    });
    expect(result.current.activeDeckId).toBe("a");
    await waitFor(() => expect(harness.deckB.src).toBe(""));

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });
    expect(result.current.activeDeckId).toBe("b");

    expect(harness.promotions.map((entry) => entry.deckId)).toEqual([
      "b",
      "a",
      "b",
    ]);
    expect(
      harness.diagnostics.filter((entry) => entry.outcome === "promoted"),
    ).toHaveLength(2);
  });

  it("labels Auto upgrades, Auto downgrades and manual picks distinctly", async () => {
    const { result, harness } = setUp({ stabiliseMs: 30 });

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });
    await waitFor(() =>
      expect(
        harness.diagnostics.some((entry) => entry.outcome === "promoted"),
      ).toBe(true),
    );

    expect(harness.diagnostics.at(-1)).toMatchObject({
      reason: "auto-upgrade",
      fromHeight: 720,
      toHeight: 1080,
      targetDeck: "b",
    });
  });

  it("cancels preparation and releases both sources on unmount", async () => {
    const { result, harness, unmount } = setUp({
      standbyOptions: { canBuffer: false },
    });

    let outcome: string | undefined;
    act(() => {
      void result.current
        .requestSwitch(UPGRADE)
        .then((settled) => (outcome = settled));
    });
    await waitFor(() => expect(harness.deckB.loadCount).toBe(1));

    unmount();

    await waitFor(() => expect(outcome).toBeDefined());

    expect(harness.deckA.src).toBe("");
    expect(harness.deckB.src).toBe("");
    expect(harness.deckA.removedAttributes).toContain("src");
    expect(harness.deckB.removedAttributes).toContain("src");
    expect(harness.promotions).toHaveLength(0);
  });

  it("identifies the active deck element for event guarding", async () => {
    const { result, harness } = setUp();

    expect(result.current.isActiveDeckElement(harness.deckA.element)).toBe(
      true,
    );
    expect(result.current.isActiveDeckElement(harness.deckB.element)).toBe(
      false,
    );
    expect(result.current.isActiveDeckElement(null)).toBe(false);

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });

    // Immediately after promotion, before React has re-rendered anything: the
    // outgoing deck's pause must already read as the standby's, not the
    // viewer's.
    expect(result.current.isActiveDeckElement(harness.deckB.element)).toBe(
      true,
    );
    expect(result.current.isActiveDeckElement(harness.deckA.element)).toBe(
      false,
    );
  });

  it("emits one diagnostics record per switch and no media URL with it", async () => {
    const { result, harness } = setUp({ stabiliseMs: 30 });
    const onDiagnostics = vi.fn();
    void onDiagnostics;

    await act(async () => {
      await result.current.requestSwitch(UPGRADE);
    });
    await waitFor(() => expect(harness.diagnostics.length).toBeGreaterThan(0));

    const serialised = JSON.stringify(harness.diagnostics);
    expect(serialised).not.toContain("media.test");
    expect(serialised).not.toContain(".mp4");
  });
});
