import { describe, expect, it } from "vitest";
import {
  applyCommand,
  currentPositionMs,
  driftCorrectionFor,
  evaluateReadiness,
  memberDriftMs,
  type SyncplayGroupState,
  type SyncplayMemberState,
} from "./syncplayState";

const T0 = 1_000_000;

function state(
  overrides: Partial<SyncplayGroupState> = {},
): SyncplayGroupState {
  return {
    sequence: 5,
    isPlaying: false,
    positionMs: 60_000,
    positionUpdatedAt: T0,
    ...overrides,
  };
}

function member(
  overrides: Partial<SyncplayMemberState> = {},
): SyncplayMemberState {
  return {
    userId: "user-1",
    displayName: "Viewer",
    isReady: true,
    isBuffering: false,
    lastPositionMs: 60_000,
    lastSeenAt: T0,
    ...overrides,
  };
}

describe("currentPositionMs", () => {
  it("holds the anchor while paused", () => {
    expect(currentPositionMs(state({ isPlaying: false }), T0 + 10_000)).toBe(
      60_000,
    );
  });

  it("advances in real time while playing", () => {
    expect(currentPositionMs(state({ isPlaying: true }), T0 + 10_000)).toBe(
      70_000,
    );
  });

  it("never reports a negative position", () => {
    expect(
      currentPositionMs(
        state({
          isPlaying: true,
          positionMs: 0,
          positionUpdatedAt: T0 + 5_000,
        }),
        T0,
      ),
    ).toBe(0);
  });
});

describe("applyCommand ordering", () => {
  it("rejects a command whose sequence has already been used", () => {
    const result = applyCommand(
      state(),
      { type: "pause", positionMs: 0 },
      5,
      T0,
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("stale-sequence");
    expect(result.state.positionMs).toBe(60_000);
  });

  it("rejects a command that arrives out of order", () => {
    const result = applyCommand(
      state(),
      { type: "seek", positionMs: 0 },
      3,
      T0,
    );
    expect(result.accepted).toBe(false);
  });

  it("accepts the next sequence and records it", () => {
    const result = applyCommand(
      state(),
      { type: "seek", positionMs: 120_000 },
      6,
      T0 + 1_000,
    );
    expect(result.accepted).toBe(true);
    expect(result.state.sequence).toBe(6);
    expect(result.state.positionMs).toBe(120_000);
  });
});

describe("applyCommand semantics", () => {
  it("play resumes from where the group actually is", () => {
    const paused = state({ isPlaying: false, positionMs: 30_000 });
    const result = applyCommand(paused, { type: "play" }, 6, T0 + 5_000);

    expect(result.state.isPlaying).toBe(true);
    expect(result.state.positionMs).toBe(30_000);
    expect(result.state.positionUpdatedAt).toBe(T0 + 5_000);
  });

  it("play from an explicit position overrides the anchor", () => {
    const result = applyCommand(
      state(),
      { type: "play", positionMs: 90_000 },
      6,
      T0,
    );
    expect(result.state.positionMs).toBe(90_000);
  });

  it("pause freezes at the reported position", () => {
    const playing = state({ isPlaying: true });
    const result = applyCommand(
      playing,
      { type: "pause", positionMs: 75_000 },
      6,
      T0 + 15_000,
    );

    expect(result.state.isPlaying).toBe(false);
    expect(result.state.positionMs).toBe(75_000);
    expect(currentPositionMs(result.state, T0 + 60_000)).toBe(75_000);
  });

  it("seek keeps the play state and only moves the anchor", () => {
    const playing = state({ isPlaying: true });
    const result = applyCommand(
      playing,
      { type: "seek", positionMs: 600_000 },
      6,
      T0 + 1_000,
    );

    expect(result.state.isPlaying).toBe(true);
    expect(result.state.positionMs).toBe(600_000);
    expect(currentPositionMs(result.state, T0 + 3_000)).toBe(602_000);
  });

  it("clamps a negative seek to the start", () => {
    const result = applyCommand(
      state(),
      { type: "seek", positionMs: -5_000 },
      6,
      T0,
    );
    expect(result.state.positionMs).toBe(0);
  });
});

describe("evaluateReadiness", () => {
  it("holds when a member is buffering", () => {
    const decision = evaluateReadiness(
      [member(), member({ userId: "user-2", isBuffering: true })],
      T0,
    );
    expect(decision.shouldHold).toBe(true);
    expect(decision.waitingFor).toEqual(["user-2"]);
  });

  it("holds when a member has not signalled ready", () => {
    const decision = evaluateReadiness(
      [member({ userId: "user-3", isReady: false })],
      T0,
    );
    expect(decision.shouldHold).toBe(true);
  });

  it("does not hold when everyone is ready", () => {
    const decision = evaluateReadiness(
      [member(), member({ userId: "u2" })],
      T0,
    );
    expect(decision).toEqual({ shouldHold: false, waitingFor: [] });
  });

  it("ignores a member who has gone silent, so a closed laptop cannot freeze the group", () => {
    const decision = evaluateReadiness(
      [
        member(),
        member({ userId: "gone", isBuffering: true, lastSeenAt: T0 - 60_000 }),
      ],
      T0,
    );
    expect(decision.shouldHold).toBe(false);
  });
});

describe("drift correction", () => {
  it("measures how far a member is ahead or behind", () => {
    const playing = state({ isPlaying: true });
    expect(
      memberDriftMs(playing, member({ lastPositionMs: 62_000 }), T0 + 1_000),
    ).toBe(1_000);
    expect(
      memberDriftMs(playing, member({ lastPositionMs: 58_000 }), T0 + 1_000),
    ).toBe(-3_000);
  });

  it("leaves imperceptible drift alone", () => {
    expect(driftCorrectionFor(120)).toBe("none");
    expect(driftCorrectionFor(-200)).toBe("none");
  });

  it("nudges small drift and hard-seeks large drift", () => {
    expect(driftCorrectionFor(800)).toBe("nudge");
    expect(driftCorrectionFor(-2_900)).toBe("nudge");
    expect(driftCorrectionFor(5_000)).toBe("seek");
    expect(driftCorrectionFor(-30_000)).toBe("seek");
  });
});
