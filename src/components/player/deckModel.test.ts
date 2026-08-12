import { describe, expect, it } from "vitest";

import {
  AUTO_RETRY_BACKOFF_MS,
  HAVE_CURRENT_DATA,
  HAVE_FUTURE_DATA,
  MAX_HANDOFF_DRIFT_SECONDS,
  MIN_BUFFER_AHEAD_SECONDS,
  OTHER_DECK,
  buildSwitchDiagnostics,
  classifySwitchReason,
  evaluatePromotionReadiness,
  evaluateSeamlessEligibility,
  evaluateStandbyReadiness,
  hasPromoted,
  initialSwitchState,
  isSwitchInFlight,
  reduceSwitch,
  requiredBufferAheadSeconds,
  type PromotionReadiness,
  type SeamlessEligibilityInput,
  type StandbyReadiness,
  type SwitchRequest,
  type SwitchState,
} from "./deckModel";

function standby(overrides: Partial<StandbyReadiness> = {}): StandbyReadiness {
  return {
    hasMetadata: true,
    durationSeconds: 3600,
    readyState: HAVE_FUTURE_DATA,
    bufferedAheadSeconds: 6,
    handoffPointSeconds: 420,
    hasDecodedFrame: true,
    superseded: false,
    failed: false,
    ...overrides,
  };
}

function promotion(
  overrides: Partial<PromotionReadiness> = {},
): PromotionReadiness {
  return {
    ...standby(),
    activePositionSeconds: 420,
    standbyPositionSeconds: 420,
    isActivePaused: false,
    ...overrides,
  };
}

function request(overrides: Partial<SwitchRequest> = {}): SwitchRequest {
  return {
    token: 1,
    reason: "auto-upgrade",
    fromQualityId: "q720",
    toQualityId: "q1080",
    fromHeight: 720,
    toHeight: 1080,
    targetDeck: "b",
    startedAtMs: 1_000,
    ...overrides,
  };
}

/** Drives the machine to `ready` so promotion tests start from a legal state. */
function readyState(token = 1): SwitchState {
  let state = reduceSwitch(initialSwitchState, {
    type: "request",
    request: request({ token }),
  });
  state = reduceSwitch(state, { type: "metadata-ready", token, atMs: 1_200 });
  state = reduceSwitch(state, {
    type: "seek-complete",
    token,
    atMs: 1_500,
    handoffPointSeconds: 421,
    rendezvousAttempts: 1,
  });
  state = reduceSwitch(state, {
    type: "frame-ready",
    token,
    atMs: 1_900,
    bufferedAheadSeconds: 7.5,
  });
  return state;
}

describe("deck identities", () => {
  it("pairs each deck with exactly the other one", () => {
    expect(OTHER_DECK.a).toBe("b");
    expect(OTHER_DECK.b).toBe("a");
  });
});

describe("requiredBufferAheadSeconds", () => {
  it("asks for the full margin in the middle of a title", () => {
    expect(requiredBufferAheadSeconds(420, 3600)).toBe(
      MIN_BUFFER_AHEAD_SECONDS,
    );
  });

  it("asks only for what is left near the end of the file", () => {
    expect(requiredBufferAheadSeconds(3599.2, 3600)).toBeCloseTo(0.8, 5);
  });

  it("never asks for a negative margin past the end", () => {
    expect(requiredBufferAheadSeconds(3601, 3600)).toBe(0);
  });

  it("falls back to the full margin when duration is unknown", () => {
    expect(requiredBufferAheadSeconds(420, Number.NaN)).toBe(
      MIN_BUFFER_AHEAD_SECONDS,
    );
  });
});

describe("evaluateStandbyReadiness", () => {
  it("accepts a fully prepared standby", () => {
    expect(evaluateStandbyReadiness(standby()).ready).toBe(true);
  });

  it("refuses without metadata", () => {
    const result = evaluateStandbyReadiness(standby({ hasMetadata: false }));
    expect(result.ready).toBe(false);
    expect(result.blockedBy).toContain("no-metadata");
  });

  it("refuses without a usable duration", () => {
    const result = evaluateStandbyReadiness(standby({ durationSeconds: 0 }));
    expect(result.ready).toBe(false);
    expect(result.blockedBy).toContain("no-duration");
  });

  it("refuses while readyState says future data is not available", () => {
    const result = evaluateStandbyReadiness(
      standby({ readyState: HAVE_CURRENT_DATA }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockedBy).toContain("ready-state");
  });

  it("refuses on a thin buffer", () => {
    const result = evaluateStandbyReadiness(
      standby({ bufferedAheadSeconds: 0.4 }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockedBy).toContain("buffer");
  });

  it("refuses before a frame is decoded", () => {
    const result = evaluateStandbyReadiness(
      standby({ hasDecodedFrame: false }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockedBy).toContain("no-frame");
  });

  it("refuses a superseded or failed target", () => {
    expect(
      evaluateStandbyReadiness(standby({ superseded: true })).blockedBy,
    ).toContain("superseded");
    expect(
      evaluateStandbyReadiness(standby({ failed: true })).blockedBy,
    ).toContain("failed");
  });

  it("says nothing about drift, because the standby parks ahead on purpose", () => {
    expect(evaluateStandbyReadiness(standby()).blockedBy).not.toContain(
      "drift",
    );
  });
});

describe("evaluatePromotionReadiness", () => {
  it("promotes when prepared and standing at the same instant", () => {
    const result = evaluatePromotionReadiness(promotion());
    expect(result.promotable).toBe(true);
    expect(result.driftSeconds).toBe(0);
  });

  it("promotes inside the drift allowance", () => {
    const result = evaluatePromotionReadiness(
      promotion({ standbyPositionSeconds: 420 + MAX_HANDOFF_DRIFT_SECONDS }),
    );
    expect(result.promotable).toBe(true);
  });

  it("refuses beyond the drift allowance", () => {
    const result = evaluatePromotionReadiness(
      promotion({ standbyPositionSeconds: 421.2 }),
    );
    expect(result.promotable).toBe(false);
    expect(result.blockedBy).toContain("drift");
    expect(result.driftSeconds).toBeCloseTo(1.2, 5);
  });

  it("holds a paused deck to a much tighter tolerance", () => {
    const result = evaluatePromotionReadiness(
      promotion({ isActivePaused: true, standbyPositionSeconds: 420.2 }),
    );
    expect(result.promotable).toBe(false);
    expect(result.blockedBy).toContain("drift");
  });

  it("still refuses an unprepared deck that happens to be in sync", () => {
    const result = evaluatePromotionReadiness(
      promotion({ hasDecodedFrame: false }),
    );
    expect(result.promotable).toBe(false);
    expect(result.blockedBy).toContain("no-frame");
  });
});

describe("evaluateSeamlessEligibility", () => {
  const eligible: SeamlessEligibilityInput = {
    currentIsCompleteFile: true,
    targetIsCompleteFile: true,
    targetIsHls: false,
    targetIsSeekable: true,
    sameTimeline: true,
    changesAudioEncode: false,
    targetCodecPlayable: true,
    partyWatchSeekInFlight: false,
    sameQuality: false,
  };

  it("accepts two validated complete files on one timeline", () => {
    expect(evaluateSeamlessEligibility(eligible).eligible).toBe(true);
  });

  it.each([
    ["hls-source", { targetIsHls: true }],
    ["not-seekable", { targetIsSeekable: false }],
    ["timeline-mismatch", { sameTimeline: false }],
    ["audio-encode-change", { changesAudioEncode: true }],
    ["codec-unsupported", { targetCodecPlayable: false }],
    ["party-watch-seek", { partyWatchSeekInFlight: true }],
    ["not-complete-file", { targetIsCompleteFile: false }],
    ["not-complete-file", { currentIsCompleteFile: false }],
    ["same-quality", { sameQuality: true }],
  ] as const)("refuses %s", (blocker, override) => {
    const result = evaluateSeamlessEligibility({ ...eligible, ...override });
    expect(result.eligible).toBe(false);
    expect(result.blockedBy).toContain(blocker);
  });
});

describe("classifySwitchReason", () => {
  it("labels a manual pick as manual regardless of direction", () => {
    expect(classifySwitchReason(1080, 720, true)).toBe("manual");
  });

  it("labels a climb as an Auto upgrade", () => {
    expect(classifySwitchReason(720, 1080, false)).toBe("auto-upgrade");
  });

  it("labels a retreat as an Auto downgrade", () => {
    expect(classifySwitchReason(1080, 720, false)).toBe("auto-downgrade");
  });

  it("treats an unknown starting rung as an upgrade", () => {
    expect(classifySwitchReason(null, 720, false)).toBe("auto-upgrade");
  });
});

describe("reduceSwitch", () => {
  it("starts idle and out of flight", () => {
    expect(initialSwitchState.phase).toBe("idle");
    expect(isSwitchInFlight(initialSwitchState)).toBe(false);
  });

  it("walks the full lifecycle to promoted", () => {
    let state = readyState();
    expect(state.phase).toBe("ready");

    state = reduceSwitch(state, {
      type: "handoff-start",
      token: 1,
      atMs: 2_000,
      driftAtHandoffSeconds: 0.02,
    });
    expect(state.phase).toBe("handing-off");

    state = reduceSwitch(state, { type: "promoted", token: 1, atMs: 2_040 });
    expect(state.phase).toBe("stabilizing");
    expect(hasPromoted(state)).toBe(true);

    state = reduceSwitch(state, { type: "settled", token: 1, atMs: 3_540 });
    expect(state.phase).toBe("idle");
    expect(state.outcome).toBe("promoted");
  });

  it("cannot reach handing-off without passing through ready", () => {
    let state = reduceSwitch(initialSwitchState, {
      type: "request",
      request: request(),
    });
    state = reduceSwitch(state, {
      type: "handoff-start",
      token: 1,
      atMs: 1_100,
      driftAtHandoffSeconds: 0,
    });
    expect(state.phase).toBe("preparing");

    state = reduceSwitch(state, {
      type: "metadata-ready",
      token: 1,
      atMs: 1_200,
    });
    state = reduceSwitch(state, {
      type: "handoff-start",
      token: 1,
      atMs: 1_300,
      driftAtHandoffSeconds: 0,
    });
    expect(state.phase).toBe("seeking");

    state = reduceSwitch(state, {
      type: "seek-complete",
      token: 1,
      atMs: 1_400,
      handoffPointSeconds: 421,
      rendezvousAttempts: 1,
    });
    state = reduceSwitch(state, {
      type: "handoff-start",
      token: 1,
      atMs: 1_500,
      driftAtHandoffSeconds: 0,
    });
    expect(state.phase).toBe("priming");
  });

  it("ignores every event carrying a superseded token", () => {
    const state = readyState(1);
    const superseded = reduceSwitch(state, {
      type: "request",
      request: request({ token: 2, targetDeck: "a" }),
    });

    expect(superseded.phase).toBe("preparing");
    expect(superseded.outcome).toBe("superseded");
    expect(superseded.request?.token).toBe(2);

    // The abandoned request keeps firing its own events; none may land.
    const afterStaleFrame = reduceSwitch(superseded, {
      type: "handoff-start",
      token: 1,
      atMs: 2_000,
      driftAtHandoffSeconds: 0,
    });
    expect(afterStaleFrame).toBe(superseded);
    expect(afterStaleFrame.phase).toBe("preparing");
  });

  it("cancels in flight and refuses to promote afterwards", () => {
    let state = readyState();
    state = reduceSwitch(state, { type: "cancel", token: 1, atMs: 2_000 });
    expect(state.phase).toBe("cancelled");
    expect(state.outcome).toBe("cancelled");

    state = reduceSwitch(state, {
      type: "handoff-start",
      token: 1,
      atMs: 2_100,
      driftAtHandoffSeconds: 0,
    });
    expect(state.phase).toBe("cancelled");
  });

  it("records a failure reason and stops the lifecycle", () => {
    let state = readyState();
    state = reduceSwitch(state, {
      type: "fail",
      token: 1,
      atMs: 2_000,
      reason: "standby-error",
    });
    expect(state.phase).toBe("failed");
    expect(state.outcome).toBe("failed");
    expect(state.failureReason).toBe("standby-error");
  });

  it("marks a post-promotion failure as rolled back", () => {
    let state = readyState();
    state = reduceSwitch(state, {
      type: "handoff-start",
      token: 1,
      atMs: 2_000,
      driftAtHandoffSeconds: 0.01,
    });
    state = reduceSwitch(state, { type: "promoted", token: 1, atMs: 2_030 });
    state = reduceSwitch(state, {
      type: "rollback",
      token: 1,
      atMs: 2_200,
      reason: "promoted-deck-error",
    });

    expect(state.outcome).toBe("rolled-back");
    expect(state.failureReason).toBe("promoted-deck-error");
  });

  it("refuses out-of-order events that would walk the phase backwards", () => {
    const state = readyState();
    const stale = reduceSwitch(state, {
      type: "metadata-ready",
      token: 1,
      atMs: 2_100,
    });
    expect(stale.phase).toBe("ready");
  });

  it("resets to the initial state", () => {
    expect(reduceSwitch(readyState(), { type: "reset" })).toEqual(
      initialSwitchState,
    );
  });
});

describe("buildSwitchDiagnostics", () => {
  it("reports the whole timeline of a promoted switch relative to its start", () => {
    let state = readyState();
    state = reduceSwitch(state, {
      type: "handoff-start",
      token: 1,
      atMs: 2_000,
      driftAtHandoffSeconds: 0.018,
    });
    state = reduceSwitch(state, { type: "promoted", token: 1, atMs: 2_042 });

    const diagnostics = buildSwitchDiagnostics(state, "promoted");

    expect(diagnostics).toMatchObject({
      token: 1,
      reason: "auto-upgrade",
      fromQualityId: "q720",
      toQualityId: "q1080",
      fromHeight: 720,
      toHeight: 1080,
      targetDeck: "b",
      outcome: "promoted",
      metadataReadyAfterMs: 200,
      seekCompleteAfterMs: 500,
      frameReadyAfterMs: 900,
      preparationDurationMs: 900,
      handoffDurationMs: 42,
      targetSeekPositionSeconds: 421,
      bufferedSecondsAhead: 7.5,
      driftAtHandoffSeconds: 0.018,
      rendezvousAttempts: 1,
    });
  });

  it("carries no URL, path, token or session field of any kind", () => {
    const diagnostics = buildSwitchDiagnostics(readyState(), "cancelled");
    const serialised = JSON.stringify(diagnostics).toLowerCase();

    expect(serialised).not.toContain("http");
    expect(serialised).not.toContain("://");
    expect(serialised).not.toContain("url");
    expect(serialised).not.toContain("session");
    expect(serialised).not.toContain("cookie");
  });

  it("returns nothing when there was never a request", () => {
    expect(buildSwitchDiagnostics(initialSwitchState, "cancelled")).toBeNull();
  });
});

describe("retry backoff", () => {
  it("keeps a failed Auto rung out of contention for a meaningful while", () => {
    expect(AUTO_RETRY_BACKOFF_MS).toBeGreaterThanOrEqual(60_000);
  });
});
