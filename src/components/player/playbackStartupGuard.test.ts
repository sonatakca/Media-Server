import { describe, expect, it } from "vitest";
import type { PlaybackSourceCandidate } from "../../lib/types";
import {
  buildPlaybackStartupDiagnostics,
  createPlaybackAttemptState,
  getFatalPlaybackSuppression,
  getStartupWatchdogMs,
  markStartupWatchdogCancelled,
  recordHlsEvent,
  recordSuccessfulPlaybackEvent,
  type PlaybackVideoSnapshot,
} from "./playbackStartupGuard";

function source(
  overrides: Partial<PlaybackSourceCandidate> = {},
): PlaybackSourceCandidate {
  return {
    id: "source-1",
    itemId: "item-1",
    mode: "DirectPlay",
    url: "http://playback.test/video.mp4",
    isHls: false,
    label: "Direct",
    mediaSource: {},
    reason: "test",
    priority: 1,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<PlaybackVideoSnapshot> = {},
): PlaybackVideoSnapshot {
  return {
    currentTime: 0,
    readyState: 0,
    networkState: 0,
    paused: true,
    duration: null,
    bufferedRanges: [],
    ...overrides,
  };
}

describe("playback startup guard", () => {
  it("uses adaptive startup watchdog durations by selected mode", () => {
    expect(getStartupWatchdogMs(source())).toBe(12_000);
    expect(
      getStartupWatchdogMs(
        source({ mode: "DirectStream", isHls: true, hlsKind: "stream-copy" }),
      ),
    ).toBe(20_000);
    expect(
      getStartupWatchdogMs(
        source({
          mode: "Transcoding",
          isHls: true,
          hlsKind: "forced-transcode",
        }),
      ),
    ).toBe(40_000);
  });

  it("suppresses the timeout when playback begins before the watchdog fires", () => {
    const attempt = createPlaybackAttemptState(1, source(), 1_000);

    recordSuccessfulPlaybackEvent(attempt, "playing");

    expect(
      getFatalPlaybackSuppression(
        attempt,
        1,
        snapshot({ currentTime: 0.25, readyState: 3, paused: false }),
      ),
    ).toMatchObject({ suppress: true, reason: "playback-healthy" });
  });

  it("ignores a timeout callback that fires after playing", () => {
    const attempt = createPlaybackAttemptState(1, source(), 1_000);

    recordSuccessfulPlaybackEvent(attempt, "playing");

    const diagnostics = buildPlaybackStartupDiagnostics({
      attempt,
      activeAttemptId: 1,
      snapshot: snapshot({ readyState: 3, paused: false }),
      nowMs: 2_500,
    });

    expect(diagnostics.watchdogCancelled).toBe(true);
    expect(diagnostics.lastSuccessfulPlaybackEvent).toBe("playing");
    expect(
      getFatalPlaybackSuppression(
        attempt,
        1,
        snapshot({ readyState: 3, paused: false }),
      ).suppress,
    ).toBe(true);
  });

  it("treats currentTime progress as healthy and clearable", () => {
    const attempt = createPlaybackAttemptState(1, source(), 1_000);

    recordSuccessfulPlaybackEvent(attempt, "timeupdate-currentTime-advanced");

    expect(
      getFatalPlaybackSuppression(
        attempt,
        1,
        snapshot({ currentTime: 12, readyState: 1, paused: false }),
      ),
    ).toMatchObject({ suppress: true, reason: "playback-healthy" });
  });

  it("suppresses an old attempt rejection after a newer attempt succeeds", () => {
    const oldAttempt = createPlaybackAttemptState(1, source(), 1_000);
    const newAttempt = createPlaybackAttemptState(
      2,
      source({ id: "source-2", url: "http://playback.test/new.m3u8" }),
      1_500,
    );

    recordSuccessfulPlaybackEvent(newAttempt, "playing");

    expect(
      getFatalPlaybackSuppression(oldAttempt, 2, snapshot()),
    ).toMatchObject({ suppress: true, staleAttempt: true });
  });

  it("keeps a source-change-cancelled old timer stale", () => {
    const oldAttempt = createPlaybackAttemptState(1, source(), 1_000);

    markStartupWatchdogCancelled(oldAttempt);

    const diagnostics = buildPlaybackStartupDiagnostics({
      attempt: oldAttempt,
      activeAttemptId: 2,
      snapshot: snapshot(),
      nowMs: 1_500,
    });

    expect(diagnostics.watchdogCancelled).toBe(true);
    expect(diagnostics.staleAttempt).toBe(true);
    expect(
      getFatalPlaybackSuppression(oldAttempt, 2, snapshot()).suppress,
    ).toBe(true);
  });

  it("records HLS FRAG_BUFFERED as a successful startup signal", () => {
    const attempt = createPlaybackAttemptState(
      1,
      source({ mode: "DirectStream", isHls: true, hlsKind: "stream-copy" }),
      1_000,
    );

    recordHlsEvent(attempt, "hlsFragBuffered");
    recordSuccessfulPlaybackEvent(attempt, "hls:hlsFragBuffered");

    const diagnostics = buildPlaybackStartupDiagnostics({
      attempt,
      activeAttemptId: 1,
      snapshot: snapshot({ bufferedRanges: [{ start: 0, end: 4 }] }),
      nowMs: 1_100,
    });

    expect(diagnostics.lastHlsEvent).toBe("hlsFragBuffered");
    expect(diagnostics.lastSuccessfulPlaybackEvent).toBe("hls:hlsFragBuffered");
    expect(diagnostics.watchdogCancelled).toBe(true);
  });

  it("does not turn a temporary stall into an immediate fatal error", () => {
    const attempt = createPlaybackAttemptState(1, source(), 1_000);

    expect(
      getFatalPlaybackSuppression(
        attempt,
        1,
        snapshot({ readyState: 1, paused: false }),
      ),
    ).toMatchObject({ suppress: true, reason: "playback-healthy" });
  });

  it("allows a real startup failure to become fatal", () => {
    const attempt = createPlaybackAttemptState(1, source(), 1_000);

    expect(getFatalPlaybackSuppression(attempt, 1, snapshot())).toMatchObject({
      suppress: false,
      reason: null,
    });
  });

  it("lets a successful retry clear the previous fatal state", () => {
    const failedAttempt = createPlaybackAttemptState(1, source(), 1_000);
    const retryAttempt = createPlaybackAttemptState(
      2,
      source({ id: "source-retry", url: "http://playback.test/retry.m3u8" }),
      2_000,
    );

    recordSuccessfulPlaybackEvent(retryAttempt, "canplay");

    expect(
      getFatalPlaybackSuppression(failedAttempt, 2, snapshot()).reason,
    ).toBe("stale-attempt");
    expect(
      getFatalPlaybackSuppression(retryAttempt, 2, snapshot({ readyState: 2 }))
        .reason,
    ).toBe("playback-healthy");
  });

  it("keeps unmounted attempts from updating later", () => {
    const attempt = createPlaybackAttemptState(1, source(), 1_000);

    markStartupWatchdogCancelled(attempt);

    expect(getFatalPlaybackSuppression(attempt, 2, snapshot())).toMatchObject({
      suppress: true,
      reason: "stale-attempt",
    });
  });
});
