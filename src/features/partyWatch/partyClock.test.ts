import { describe, expect, it } from "vitest";
import { createPartyClock } from "./partyClock";

describe("the party clock", () => {
  it("uses local time until it has heard from the server", () => {
    const clock = createPartyClock(() => 1_000);
    expect(clock.serverNow()).toBe(1_000);
    expect(clock.offsetMs()).toBeNull();
  });

  it("finds a skewed device's offset from a round trip", () => {
    // This device runs 2.5 s behind the server; the network takes 40 ms each way.
    let local = 10_000;
    const clock = createPartyClock(() => local);
    clock.addSample({
      sentAt: 10_000,
      receivedAt: 10_080,
      serverTimeMs: 10_000 + 40 + 2_500,
    });
    local = 20_000;
    expect(clock.offsetMs()).toBe(2_500);
    expect(clock.serverNow()).toBe(22_500);
  });

  it("trusts the fastest round trip over a slower, lopsided one", () => {
    let local = 0;
    const clock = createPartyClock(() => local);
    // A slow sample whose delay was all on the way back: its midpoint is 450 ms off.
    clock.addSample({ sentAt: 0, receivedAt: 1_000, serverTimeMs: 50 });
    clock.addSample({ sentAt: 2_000, receivedAt: 2_060, serverTimeMs: 2_030 });
    local = 3_000;
    expect(clock.offsetMs()).toBe(0);
    expect(clock.roundTripMs()).toBe(60);
  });

  it("lets old samples go, so a corrected device clock is picked up", () => {
    let local = 0;
    const clock = createPartyClock(() => local);
    clock.addSample({ sentAt: 0, receivedAt: 20, serverTimeMs: 1_010 });
    expect(clock.offsetMs()).toBe(1_000);

    // Four minutes on, the device corrected itself; the new sample is slower,
    // but it is the only one that still describes the clocks.
    local = 240_000;
    clock.addSample({
      sentAt: 240_000,
      receivedAt: 240_100,
      serverTimeMs: 240_050,
    });
    expect(clock.offsetMs()).toBe(0);
  });

  it("ignores samples that cannot be right", () => {
    const clock = createPartyClock(() => 0);
    clock.addSample({ sentAt: 100, receivedAt: 50, serverTimeMs: 75 });
    clock.addSample({ sentAt: 0, receivedAt: 30_000, serverTimeMs: 15_000 });
    clock.addSample({ sentAt: 0, receivedAt: 10, serverTimeMs: Number.NaN });
    expect(clock.offsetMs()).toBeNull();
  });
});
