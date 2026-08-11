import { afterEach, describe, expect, it, vi } from "vitest";
import { nextProgressSequence } from "./progressSequence";

afterEach(() => {
  vi.useRealTimers();
});

describe("progress sequence", () => {
  it("starts above any sequence a previous page load could have written", () => {
    // The server keeps the highest sequence ever stored for an item. A counter
    // starting at zero meant every write after the first viewing arrived below
    // it and was rejected as stale, so progress stopped being saved for
    // anything already watched once.
    const first = nextProgressSequence();

    // A session lasting hours writes a few thousand times at most; the wall
    // clock is thirteen digits, so the first write of a new load clears
    // anything the previous one could have reached.
    expect(first).toBeGreaterThan(Date.now() - 60_000);
  });

  it("strictly increases even within a single millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00Z"));

    const values = [
      nextProgressSequence(),
      nextProgressSequence(),
      nextProgressSequence(),
    ];

    expect(values[1]).toBeGreaterThan(values[0] as number);
    expect(values[2]).toBeGreaterThan(values[1] as number);
  });

  it("keeps increasing when the clock jumps backwards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00Z"));
    const before = nextProgressSequence();

    // A daylight-saving change or an NTP correction must not make the next
    // write look stale to the server.
    vi.setSystemTime(new Date("2026-08-11T11:00:00Z"));
    const after = nextProgressSequence();

    expect(after).toBeGreaterThan(before);
  });
});
