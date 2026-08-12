import { describe, expect, it, vi } from "vitest";

import { HANDOFF_LEAD_SECONDS, MAX_RENDEZVOUS_ATTEMPTS } from "./deckModel";
import {
  bufferedAheadOf,
  prepareStandbyDeck,
  releaseDeck,
  type ActiveDeckReading,
  type DeckClock,
  type DeckMedia,
  type PrepareProgressEvent,
} from "./prepareStandbyDeck";

const clock: DeckClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
  requestAnimationFrame: (callback) =>
    setTimeout(callback, 0) as unknown as number,
  cancelAnimationFrame: (handle) => clearTimeout(handle),
};

interface FakeDeckOptions {
  durationSeconds?: number;
  bufferAheadSeconds?: number;
  hasFrameCallback?: boolean;
  gates?: Partial<FakeGates>;
}

interface FakeGates {
  metadata: boolean;
  seek: boolean;
  buffer: boolean;
  frame: boolean;
  play: boolean;
}

/**
 * A media element that reaches each readiness stage only when its gate is open,
 * so a test can hold preparation at any point and assert what has *not* yet
 * happened.
 */
class FakeDeck implements DeckMedia {
  src = "";
  preload = "none";
  muted = false;
  volume = 1;
  playbackRate = 1;
  paused = true;
  seeking = false;

  loadCount = 0;
  playCount = 0;
  pauseCount = 0;
  seekTargets: number[] = [];

  readonly gates: FakeGates;
  readonly durationSeconds: number;
  bufferAheadSeconds: number;

  private listeners = new Map<string, Set<() => void>>();
  private metadataDone = false;
  private seekDone = false;
  private position = 0;
  private frameHandles = new Map<number, ReturnType<typeof setTimeout>>();
  private nextFrameHandle = 1;

  /**
   * Own properties rather than methods, so a browser without the API can be
   * modelled by simply not defining them — which is what Firefox looks like.
   */
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;

  constructor({
    durationSeconds = 3600,
    bufferAheadSeconds = 6,
    hasFrameCallback = true,
    gates = {},
  }: FakeDeckOptions = {}) {
    this.durationSeconds = durationSeconds;
    this.bufferAheadSeconds = bufferAheadSeconds;
    this.gates = {
      metadata: true,
      seek: true,
      buffer: true,
      frame: true,
      play: true,
      ...gates,
    };

    if (hasFrameCallback) {
      this.requestVideoFrameCallback = (callback: () => void) => {
        const handle = this.nextFrameHandle;
        this.nextFrameHandle += 1;
        if (!this.gates.frame) return handle;

        this.frameHandles.set(
          handle,
          setTimeout(() => {
            this.frameHandles.delete(handle);
            callback();
          }, 0),
        );
        return handle;
      };
      this.cancelVideoFrameCallback = (handle: number) => {
        const timer = this.frameHandles.get(handle);
        if (timer) clearTimeout(timer);
        this.frameHandles.delete(handle);
      };
    }
  }

  get duration(): number {
    return this.metadataDone ? this.durationSeconds : Number.NaN;
  }

  /**
   * Zero until something has been decoded, which is what a real element
   * reports. Closing the frame gate has to close *both* detection routes —
   * `requestVideoFrameCallback` and the events-plus-animation-frames
   * fallback — or the gate is not modelling anything.
   */
  get videoWidth(): number {
    return this.gates.frame ? 1920 : 0;
  }

  get readyState(): number {
    if (!this.metadataDone) return 0;
    if (!this.seekDone) return 1;
    if (!this.gates.buffer) return 2;
    return 3;
  }

  get currentTime(): number {
    return this.position;
  }

  set currentTime(seconds: number) {
    this.position = seconds;
    this.seekTargets.push(seconds);
    this.seekDone = false;
    this.seeking = true;

    if (!this.gates.seek) return;
    setTimeout(() => {
      this.seekDone = true;
      this.seeking = false;
      this.emit("seeked");
    }, 0);
  }

  get buffered() {
    const ranges = this.gates.buffer
      ? [
          {
            start: Math.max(0, this.position - 1),
            end: Math.min(
              this.durationSeconds,
              this.position + this.bufferAheadSeconds,
            ),
          },
        ]
      : [];

    return {
      length: ranges.length,
      start: (index: number) => ranges[index].start,
      end: (index: number) => ranges[index].end,
    };
  }

  load(): void {
    this.loadCount += 1;
    if (!this.gates.metadata) return;

    setTimeout(() => {
      this.metadataDone = true;
      this.emit("loadedmetadata");
    }, 0);
  }

  play(): Promise<void> {
    this.playCount += 1;
    if (!this.gates.play) return Promise.reject(new Error("NotAllowedError"));

    this.paused = false;
    // A priming pulse advances the deck by about a frame.
    this.position += 0.04;
    setTimeout(() => this.emit("playing"), 0);
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCount += 1;
    this.paused = true;
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

  fail(): void {
    this.emit("error");
  }
}

/** A stand-in for the deck that keeps playing while the standby is prepared. */
class FakeActiveDeck {
  positionSeconds: number;
  paused = false;
  playbackRate = 1;
  pauseCount = 0;
  srcWrites = 0;
  loadCount = 0;

  constructor(positionSeconds = 420) {
    this.positionSeconds = positionSeconds;
  }

  read = (): ActiveDeckReading => ({
    positionSeconds: this.positionSeconds,
    paused: this.paused,
    playbackRate: this.playbackRate,
  });

  pause(): void {
    this.pauseCount += 1;
    this.paused = true;
  }

  setSource(): void {
    this.srcWrites += 1;
  }

  load(): void {
    this.loadCount += 1;
  }
}

function prepare(
  standby: FakeDeck,
  active: FakeActiveDeck,
  overrides: Partial<Parameters<typeof prepareStandbyDeck>[0]> = {},
) {
  const progress: PrepareProgressEvent[] = [];

  const promise = prepareStandbyDeck({
    standby,
    url: "https://media.test/renditions/1080p.mp4",
    clock,
    readActive: active.read,
    isSuperseded: () => false,
    onProgress: (event) => progress.push(event),
    pollMs: 5,
    deadlineMs: 3_000,
    ...overrides,
  });

  return { promise, progress };
}

describe("bufferedAheadOf", () => {
  it("measures the range containing the position", () => {
    const media = {
      buffered: {
        length: 2,
        start: (index: number) => [0, 400][index],
        end: (index: number) => [100, 460][index],
      },
    };
    expect(bufferedAheadOf(media, 420)).toBe(40);
  });

  it("reports nothing when the position sits in a hole", () => {
    const media = {
      buffered: {
        length: 1,
        start: () => 0,
        end: () => 100,
      },
    };
    expect(bufferedAheadOf(media, 420)).toBe(0);
  });
});

describe("prepareStandbyDeck", () => {
  it("prepares a standby without touching the active deck", async () => {
    const standby = new FakeDeck();
    const active = new FakeActiveDeck(420);
    const { promise, progress } = prepare(standby, active);

    const result = await promise;

    expect(result.outcome).toBe("ready");
    // The whole point: the deck the viewer is watching was never paused, never
    // reloaded and never had its source rewritten.
    expect(active.pauseCount).toBe(0);
    expect(active.srcWrites).toBe(0);
    expect(active.loadCount).toBe(0);
    expect(active.paused).toBe(false);
    expect(progress.map((event) => event.type)).toEqual([
      "metadata-ready",
      "seek-complete",
      "frame-ready",
    ]);
  });

  it("configures the standby for hidden, muted, eager preparation", async () => {
    const standby = new FakeDeck();
    const active = new FakeActiveDeck(420);
    active.playbackRate = 1.5;

    await prepare(standby, active).promise;

    expect(standby.preload).toBe("auto");
    expect(standby.muted).toBe(true);
    expect(standby.playbackRate).toBe(1.5);
    expect(standby.src).toBe("https://media.test/renditions/1080p.mp4");
    expect(standby.loadCount).toBe(1);
  });

  it("parks the standby ahead of the playhead rather than on it", async () => {
    const standby = new FakeDeck();
    const active = new FakeActiveDeck(420);

    const result = await prepare(standby, active).promise;

    expect(standby.seekTargets[0]).toBeCloseTo(420 + HANDOFF_LEAD_SECONDS, 5);
    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") return;
    expect(result.handoffPointSeconds).toBeGreaterThan(420);
  });

  it("seeks from the live playhead, not the position captured at the start", async () => {
    const standby = new FakeDeck({ gates: { metadata: false } });
    const active = new FakeActiveDeck(420);
    const { promise } = prepare(standby, active);

    // Loading took a while and the title kept playing throughout.
    await new Promise((resolve) => setTimeout(resolve, 30));
    active.positionSeconds = 437;
    standby.gates.metadata = true;
    standby.load();

    await promise;

    expect(standby.seekTargets[0]).toBeCloseTo(437 + HANDOFF_LEAD_SECONDS, 5);
  });

  it("matches the exact position when the active deck is paused", async () => {
    const standby = new FakeDeck();
    const active = new FakeActiveDeck(420);
    active.paused = true;

    const result = await prepare(standby, active).promise;

    expect(standby.seekTargets[0]).toBe(420);
    expect(result.outcome).toBe("ready");
  });

  it("never reports ready before metadata arrives", async () => {
    const standby = new FakeDeck({ gates: { metadata: false } });
    const active = new FakeActiveDeck(420);
    const { promise, progress } = prepare(standby, active, {
      deadlineMs: 120,
    });

    const result = await promise;

    expect(result).toEqual({ outcome: "failed", reason: "metadata-timeout" });
    expect(progress).toHaveLength(0);
    expect(standby.seekTargets).toHaveLength(0);
  });

  it("never reports ready before the seek completes", async () => {
    const standby = new FakeDeck({ gates: { seek: false } });
    const active = new FakeActiveDeck(420);

    const result = await prepare(standby, active, { deadlineMs: 150 }).promise;

    expect(result).toEqual({ outcome: "failed", reason: "seek-timeout" });
  });

  it("never reports ready on a thin buffer", async () => {
    const standby = new FakeDeck({ gates: { buffer: false } });
    const active = new FakeActiveDeck(420);
    const { promise, progress } = prepare(standby, active, {
      deadlineMs: 150,
    });

    const result = await promise;

    expect(result).toEqual({ outcome: "failed", reason: "buffer-timeout" });
    expect(progress.map((event) => event.type)).toEqual([
      "metadata-ready",
      "seek-complete",
    ]);
  });

  it("never reports ready before a frame is decoded", async () => {
    const standby = new FakeDeck({ gates: { frame: false } });
    const active = new FakeActiveDeck(420);
    const { promise, progress } = prepare(standby, active, {
      deadlineMs: 5_000,
      frameWaitMs: 150,
    });

    const result = await promise;

    expect(result).toEqual({ outcome: "failed", reason: "frame-timeout" });
    expect(progress.map((event) => event.type)).not.toContain("frame-ready");
  });

  it("reaches a decoded frame without requestVideoFrameCallback", async () => {
    const standby = new FakeDeck({ hasFrameCallback: false });
    const active = new FakeActiveDeck(420);

    expect(standby.requestVideoFrameCallback).toBeUndefined();

    const result = await prepare(standby, active).promise;

    expect(result.outcome).toBe("ready");
  });

  it("still prepares when the browser refuses the muted priming pulse", async () => {
    const standby = new FakeDeck({ gates: { play: false } });
    const active = new FakeActiveDeck(420);

    const result = await prepare(standby, active).promise;

    expect(standby.playCount).toBe(1);
    expect(result.outcome).toBe("ready");
  });

  it("leaves the standby paused after priming", async () => {
    const standby = new FakeDeck();
    const active = new FakeActiveDeck(420);

    await prepare(standby, active).promise;

    expect(standby.paused).toBe(true);
    expect(standby.pauseCount).toBeGreaterThan(0);
  });

  it("abandons preparation as superseded once a newer request takes over", async () => {
    const standby = new FakeDeck({ gates: { buffer: false } });
    const active = new FakeActiveDeck(420);
    let superseded = false;

    const { promise } = prepare(standby, active, {
      isSuperseded: () => superseded,
      deadlineMs: 3_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    superseded = true;

    await expect(promise).resolves.toEqual({ outcome: "superseded" });
  });

  it("fails on a media error instead of promoting anything", async () => {
    const standby = new FakeDeck({ gates: { buffer: false } });
    const active = new FakeActiveDeck(420);
    const { promise } = prepare(standby, active, { deadlineMs: 3_000 });

    await new Promise((resolve) => setTimeout(resolve, 30));
    standby.fail();

    await expect(promise).resolves.toEqual({
      outcome: "failed",
      reason: "media-error",
    });
  });

  it("re-seeks when the playhead overtakes the meeting point during preparation", async () => {
    const standby = new FakeDeck();
    const active = new FakeActiveDeck(420);
    const onProgress = vi.fn((event: PrepareProgressEvent) => {
      // The first rendezvous is overrun: by the time the seek lands the viewer
      // is already past it.
      if (event.type === "seek-complete" && active.positionSeconds === 420) {
        active.positionSeconds = 425;
      }
    });

    const result = await prepareStandbyDeck({
      standby,
      url: "https://media.test/renditions/1080p.mp4",
      clock,
      readActive: active.read,
      isSuperseded: () => false,
      onProgress,
      pollMs: 5,
      deadlineMs: 3_000,
    });

    expect(standby.seekTargets.length).toBeGreaterThanOrEqual(2);
    expect(standby.seekTargets[1]).toBeCloseTo(425 + HANDOFF_LEAD_SECONDS, 5);
    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") return;
    expect(result.rendezvousAttempts).toBe(2);
  });

  it("fails rather than promoting into the past when it can never catch up", async () => {
    const standby = new FakeDeck();
    const active = new FakeActiveDeck(420);
    // The playhead runs away faster than the lead on every single attempt.
    const onProgress = (event: PrepareProgressEvent) => {
      if (event.type === "seek-complete") active.positionSeconds += 30;
    };

    const result = await prepareStandbyDeck({
      standby,
      url: "https://media.test/renditions/1080p.mp4",
      clock,
      readActive: active.read,
      isSuperseded: () => false,
      onProgress,
      pollMs: 5,
      deadlineMs: 5_000,
    });

    expect(result).toEqual({
      outcome: "failed",
      reason: "rendezvous-overrun",
    });
    expect(standby.seekTargets).toHaveLength(MAX_RENDEZVOUS_ATTEMPTS);
  });

  it("clamps the meeting point inside the file near the end of a title", async () => {
    const standby = new FakeDeck({ durationSeconds: 100 });
    const active = new FakeActiveDeck(99.2);

    const result = await prepare(standby, active).promise;

    expect(standby.seekTargets[0]).toBeLessThanOrEqual(99.75);
    expect(result.outcome).toBe("ready");
  });

  it("declines rather than promotes in the last moments of a title", async () => {
    // There is no room left to park ahead of the playhead, so there is no
    // rendezvous to be had. Declining keeps the current quality playing to the
    // credits, which is the right answer for the last fraction of a second.
    const standby = new FakeDeck({ durationSeconds: 100 });
    const active = new FakeActiveDeck(99.9);

    const result = await prepare(standby, active).promise;

    expect(result).toEqual({
      outcome: "failed",
      reason: "rendezvous-overrun",
    });
  });

  it("reports the buffer it actually measured at the meeting point", async () => {
    const standby = new FakeDeck({ bufferAheadSeconds: 9 });
    const active = new FakeActiveDeck(420);

    const result = await prepare(standby, active).promise;

    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") return;
    expect(result.bufferedAheadSeconds).toBeCloseTo(9, 1);
  });
});

describe("releaseDeck", () => {
  it("pauses and clears the deck so it can become the next standby", () => {
    const standby = new FakeDeck();
    standby.src = "https://media.test/renditions/720p.mp4";

    releaseDeck(standby);

    expect(standby.pauseCount).toBe(1);
    expect(standby.src).toBe("");
    expect(standby.loadCount).toBe(1);
  });
});
