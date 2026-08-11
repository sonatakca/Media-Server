import { describe, expect, it, vi } from "vitest";
import { warmQualityAtPosition, type WarmableMedia } from "./warmQuality";

/** A media element that records what was done to it, in order. */
function fakeMedia(readyState = 0) {
  const listeners = new Map<string, Array<() => void>>();
  const calls: string[] = [];

  const element: WarmableMedia & { seekedTo: number | null } = {
    preload: "none",
    muted: false,
    src: "",
    readyState,
    seekedTo: null,
    get currentTime() {
      return this.seekedTo ?? 0;
    },
    set currentTime(value: number) {
      this.seekedTo = value;
      calls.push(`seek:${value}`);
    },
    load() {
      calls.push("load");
      // A real element discards any position set before the load.
      this.seekedTo = null;
    },
    addEventListener(type, listener) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
  };

  const emit = (type: string) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener();
  };

  return { element, emit, calls, listeners };
}

function timers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    fired: [] as number[],
    setTimeout: (handler: () => void) => {
      const handle = next++;
      pending.set(handle, handler);
      return handle;
    },
    clearTimeout: (handle: number) => pending.delete(handle),
    setInterval: (handler: () => void) => {
      const handle = next++;
      pending.set(handle, handler);
      return handle;
    },
    clearInterval: (handle: number) => pending.delete(handle),
    fire: (handle: number) => pending.get(handle)?.(),
    size: () => pending.size,
  };
}

function warm(
  element: WarmableMedia,
  clock: ReturnType<typeof timers>,
  overrides: Partial<Parameters<typeof warmQualityAtPosition>[0]> = {},
) {
  return warmQualityAtPosition({
    element,
    url: "https://media.test/480.mp4",
    positionSeconds: 1200,
    budgetMs: 20_000,
    isSuperseded: () => false,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    ...overrides,
  });
}

describe("warming a quality before switching", () => {
  it("seeks only after metadata, because load() discards an earlier position", () => {
    const { element, emit, calls } = fakeMedia(0);
    const clock = timers();

    void warm(element, clock);

    // Nothing has been sought yet: the element does not know its duration.
    expect(calls).toEqual(["load"]);
    expect(element.src).toBe("https://media.test/480.mp4");
    expect(element.preload).toBe("auto");
    expect(element.muted).toBe(true);

    emit("loadedmetadata");
    expect(calls).toEqual(["load", "seek:1200"]);
  });

  it("seeks immediately when metadata is already there", () => {
    const { element, calls } = fakeMedia(1);
    const clock = timers();

    void warm(element, clock);

    expect(calls).toEqual(["load", "seek:1200"]);
  });

  it("does not treat buffering before the seek as ready", async () => {
    // The opening minutes are exactly the part a mid-film switch never plays,
    // so being ready there says nothing about being ready to switch.
    const { element, emit } = fakeMedia(0);
    const clock = timers();
    const settled = vi.fn();

    void warm(element, clock).then(settled);

    emit("canplaythrough");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    emit("loadedmetadata");
    emit("canplaythrough");
    await Promise.resolve();
    expect(settled).toHaveBeenCalled();
  });

  it("needs no seek when the switch happens at the very start", async () => {
    const { element, emit } = fakeMedia(0);
    const clock = timers();
    const settled = vi.fn();

    void warm(element, clock, { positionSeconds: 0 }).then(settled);

    emit("canplaythrough");
    await Promise.resolve();
    expect(settled).toHaveBeenCalled();
  });

  it("gives up on the budget rather than holding the switch forever", async () => {
    const { element } = fakeMedia(0);
    const clock = timers();
    const settled = vi.fn();

    void warm(element, clock).then(settled);
    clock.fire(1);
    await Promise.resolve();

    expect(settled).toHaveBeenCalled();
  });

  it("stops waiting once a newer selection supersedes it", async () => {
    const { element } = fakeMedia(0);
    const clock = timers();
    const settled = vi.fn();
    let superseded = false;

    void warm(element, clock, { isSuperseded: () => superseded }).then(settled);

    clock.fire(2);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    superseded = true;
    clock.fire(2);
    await Promise.resolve();
    expect(settled).toHaveBeenCalled();
  });

  it("leaves no timer or listener behind once it settles", async () => {
    const { element, emit, listeners } = fakeMedia(1);
    const clock = timers();

    const promise = warm(element, clock);
    emit("canplaythrough");
    await promise;

    expect(clock.size()).toBe(0);
    for (const [, entries] of listeners) expect(entries).toHaveLength(0);
  });

  it("settles when the element reports an error", async () => {
    const { element, emit } = fakeMedia(0);
    const clock = timers();
    const settled = vi.fn();

    void warm(element, clock).then(settled);
    emit("error");
    await Promise.resolve();

    expect(settled).toHaveBeenCalled();
  });
});
