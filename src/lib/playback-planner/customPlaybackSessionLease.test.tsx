import React, { StrictMode } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackSourceCandidate } from "../types";
import {
  releaseCustomPlaybackSession,
  resetCustomPlaybackSessionLeasesForTests,
  retainCustomPlaybackSession,
  stopCustomPlaybackSessionImmediately,
  useCustomPlaybackSessionLease,
} from "./customPlaybackSessionLease";

function customSource(
  sessionId: string | undefined,
  id = `custom-audio-transcode-${sessionId ?? "file"}`,
): PlaybackSourceCandidate {
  return {
    id,
    itemId: "movie-1",
    mediaSourceId: "movie-1",
    playSessionId: sessionId,
    mode: "DirectStream",
    url: sessionId
      ? `http://backend.test/api/playback/sessions/${sessionId}/master.m3u8`
      : "http://backend.test/api/playback/direct/token",
    mimeType: sessionId ? "application/vnd.apple.mpegurl" : "video/mp4",
    isHls: Boolean(sessionId),
    hlsKind: sessionId ? "audio-transcode" : "direct",
    label: "Custom playback",
    reason: "",
    mediaSource: {
      Id: "movie-1",
      Container: "mp4",
      SupportsDirectPlay: !sessionId,
      SupportsDirectStream: Boolean(sessionId),
      SupportsTranscoding: false,
      MediaStreams: [],
    },
    priority: 0,
  };
}

function nonCustomSource(
  sessionId = "jellyfin-session",
): PlaybackSourceCandidate {
  return {
    ...customSource(sessionId, "jellyfin-source"),
    id: "jellyfin-source",
  };
}

function LeaseHarness({ source }: { source: PlaybackSourceCandidate | null }) {
  useCustomPlaybackSessionLease(source);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_SEYIRLIK_PLAYBACK_BACKEND_URL", "http://backend.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
  );
  resetCustomPlaybackSessionLeasesForTests();
});

afterEach(() => {
  resetCustomPlaybackSessionLeasesForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("custom playback session lease", () => {
  it("schedules one delayed stop after release", async () => {
    const source = customSource("session-a");

    retainCustomPlaybackSession(source);
    releaseCustomPlaybackSession(source, { graceMs: 750 });

    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(749);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending stop when the same session is retained again", async () => {
    const source = customSource("session-a");

    retainCustomPlaybackSession(source);
    releaseCustomPlaybackSession(source, { graceMs: 750 });
    retainCustomPlaybackSession(source);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not stop during a Strict Mode-like retain release retain sequence", async () => {
    const source = customSource("session-a");

    retainCustomPlaybackSession(source);
    releaseCustomPlaybackSession(source, { graceMs: 750 });
    retainCustomPlaybackSession(source);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).not.toHaveBeenCalled();

    releaseCustomPlaybackSession(source, { graceMs: 750 });
    await vi.advanceTimersByTimeAsync(750);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not send repeated stops for repeated release calls", async () => {
    const source = customSource("session-a");

    retainCustomPlaybackSession(source);
    releaseCustomPlaybackSession(source, { graceMs: 750 });
    releaseCustomPlaybackSession(source, { graceMs: 750 });
    releaseCustomPlaybackSession(source, { graceMs: 750 });

    await vi.advanceTimersByTimeAsync(750);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops a previous session after switching while retaining the next one", async () => {
    const sourceA = customSource("session-a");
    const sourceB = customSource("session-b");

    retainCustomPlaybackSession(sourceA);
    releaseCustomPlaybackSession(sourceA, { graceMs: 750 });
    retainCustomPlaybackSession(sourceB);

    await vi.advanceTimersByTimeAsync(750);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      "/sessions/session-a/stop",
    );
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).not.toContain(
      "session-b",
    );
  });

  it("ignores non-custom and direct-file candidates", async () => {
    retainCustomPlaybackSession(nonCustomSource("jellyfin-session"));
    releaseCustomPlaybackSession(nonCustomSource("jellyfin-session"), {
      graceMs: 750,
    });
    retainCustomPlaybackSession(customSource(undefined));
    releaseCustomPlaybackSession(customSource(undefined), { graceMs: 750 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses keepalive for immediate unload stops", async () => {
    await stopCustomPlaybackSessionImmediately(customSource("session-a"), {
      keepalive: true,
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://backend.test/api/playback/sessions/session-a/stop",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
      }),
    );
  });

  it("does not stop the active custom session during Strict Mode effect replay", async () => {
    const source = customSource("session-a");
    const view = render(
      <StrictMode>
        <LeaseHarness source={source} />
      </StrictMode>,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).not.toHaveBeenCalled();

    view.unmount();
    await vi.advanceTimersByTimeAsync(750);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops only the previous session after a source switch", async () => {
    const view = render(<LeaseHarness source={customSource("session-a")} />);

    view.rerender(<LeaseHarness source={customSource("session-b")} />);
    await vi.advanceTimersByTimeAsync(750);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      "/sessions/session-a/stop",
    );

    view.unmount();
    await vi.advanceTimersByTimeAsync(750);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain(
      "/sessions/session-b/stop",
    );
  });
});
