import type { PlaybackSourceCandidate } from "../../lib/types";
import {
  DIRECT_PLAY_STARTUP_WATCHDOG_MS,
  HLS_REMUX_STARTUP_WATCHDOG_MS,
  HLS_TRANSCODE_STARTUP_WATCHDOG_MS,
} from "./constants";

export interface BufferedRangeSnapshot {
  start: number;
  end: number;
}

export interface PlaybackVideoSnapshot {
  currentTime: number;
  readyState: number;
  networkState: number;
  paused: boolean;
  duration: number | null;
  bufferedRanges: BufferedRangeSnapshot[];
}

export interface PlaybackAttemptState {
  id: number;
  source: PlaybackSourceCandidate;
  startedAtMs: number;
  startupWatchdogMs: number;
  lastSuccessfulPlaybackEvent: string | null;
  lastHlsEvent: string | null;
  watchdogCancelled: boolean;
}

export interface PlaybackStartupDiagnostics {
  playbackAttemptId: number;
  activePlaybackAttemptId: number;
  selectedMode: PlaybackSourceCandidate["mode"];
  hlsKind: PlaybackSourceCandidate["hlsKind"] | null;
  isHls: boolean;
  usingHlsJs: boolean | null;
  elapsedStartupMs: number;
  startupWatchdogMs: number;
  currentTime: number;
  readyState: number;
  networkState: number;
  paused: boolean;
  duration: number | null;
  bufferedRanges: BufferedRangeSnapshot[];
  lastSuccessfulPlaybackEvent: string | null;
  lastHlsEvent: string | null;
  staleAttempt: boolean;
  watchdogCancelled: boolean;
}

export interface FatalPlaybackSuppression {
  suppress: boolean;
  staleAttempt: boolean;
  reason: "stale-attempt" | "playback-healthy" | null;
}

const PLAYABLE_BUFFER_SECONDS = 0.1;
const HAVE_CURRENT_DATA_READY_STATE = 2;

export function getStartupWatchdogMs(
  source: Pick<PlaybackSourceCandidate, "mode" | "isHls" | "hlsKind">,
): number {
  if (!source.isHls && source.mode === "DirectPlay") {
    return DIRECT_PLAY_STARTUP_WATCHDOG_MS;
  }

  if (
    source.isHls &&
    (source.mode === "Transcoding" ||
      source.hlsKind === "audio-transcode" ||
      source.hlsKind === "forced-transcode" ||
      source.hlsKind === "jellyfin-transcoding-url")
  ) {
    return HLS_TRANSCODE_STARTUP_WATCHDOG_MS;
  }

  if (source.isHls) {
    return HLS_REMUX_STARTUP_WATCHDOG_MS;
  }

  return DIRECT_PLAY_STARTUP_WATCHDOG_MS;
}

export function createPlaybackAttemptState(
  id: number,
  source: PlaybackSourceCandidate,
  startedAtMs = Date.now(),
): PlaybackAttemptState {
  return {
    id,
    source,
    startedAtMs,
    startupWatchdogMs: getStartupWatchdogMs(source),
    lastSuccessfulPlaybackEvent: null,
    lastHlsEvent: null,
    watchdogCancelled: false,
  };
}

export function getBufferedRangeSnapshot(
  buffered: TimeRanges | null | undefined,
): BufferedRangeSnapshot[] {
  if (!buffered) {
    return [];
  }

  const ranges: BufferedRangeSnapshot[] = [];

  for (let index = 0; index < buffered.length; index += 1) {
    try {
      ranges.push({
        start: buffered.start(index),
        end: buffered.end(index),
      });
    } catch {
      break;
    }
  }

  return ranges;
}

export function getVideoSnapshot(
  video: HTMLVideoElement,
): PlaybackVideoSnapshot {
  return {
    currentTime: video.currentTime,
    readyState: video.readyState,
    networkState: video.networkState,
    paused: video.paused,
    duration: Number.isFinite(video.duration) ? video.duration : null,
    bufferedRanges: getBufferedRangeSnapshot(video.buffered),
  };
}

export function hasPlayableBuffer(
  snapshot: Pick<PlaybackVideoSnapshot, "currentTime" | "bufferedRanges">,
): boolean {
  const currentTime = Math.max(0, snapshot.currentTime);

  return snapshot.bufferedRanges.some((range) => {
    if (range.end <= range.start) {
      return false;
    }

    if (currentTime < range.start - PLAYABLE_BUFFER_SECONDS) {
      return false;
    }

    return (
      range.end - Math.max(range.start, currentTime) >= PLAYABLE_BUFFER_SECONDS
    );
  });
}

export function isPlaybackStartupHealthy(
  snapshot: PlaybackVideoSnapshot,
): boolean {
  return (
    snapshot.currentTime > 0 ||
    snapshot.readyState >= HAVE_CURRENT_DATA_READY_STATE ||
    hasPlayableBuffer(snapshot) ||
    (!snapshot.paused && snapshot.readyState > 0)
  );
}

export function recordSuccessfulPlaybackEvent(
  attempt: PlaybackAttemptState,
  eventName: string,
): void {
  attempt.lastSuccessfulPlaybackEvent = eventName;
  attempt.watchdogCancelled = true;
}

export function recordHlsEvent(
  attempt: PlaybackAttemptState,
  eventName: string,
): void {
  attempt.lastHlsEvent = eventName;
}

export function markStartupWatchdogCancelled(
  attempt: PlaybackAttemptState,
): void {
  attempt.watchdogCancelled = true;
}

export function getFatalPlaybackSuppression(
  attempt: PlaybackAttemptState,
  activeAttemptId: number,
  snapshot: PlaybackVideoSnapshot,
): FatalPlaybackSuppression {
  const staleAttempt = attempt.id !== activeAttemptId;

  if (staleAttempt) {
    return {
      suppress: true,
      staleAttempt,
      reason: "stale-attempt",
    };
  }

  if (isPlaybackStartupHealthy(snapshot)) {
    return {
      suppress: true,
      staleAttempt,
      reason: "playback-healthy",
    };
  }

  return {
    suppress: false,
    staleAttempt,
    reason: null,
  };
}

export function buildPlaybackStartupDiagnostics({
  attempt,
  activeAttemptId,
  snapshot,
  nowMs = Date.now(),
}: {
  attempt: PlaybackAttemptState;
  activeAttemptId: number;
  snapshot: PlaybackVideoSnapshot;
  nowMs?: number;
}): PlaybackStartupDiagnostics {
  return {
    playbackAttemptId: attempt.id,
    activePlaybackAttemptId: activeAttemptId,
    selectedMode: attempt.source.mode,
    hlsKind: attempt.source.hlsKind ?? null,
    isHls: attempt.source.isHls,
    usingHlsJs: attempt.source.usingHlsJs ?? null,
    elapsedStartupMs: Math.max(0, nowMs - attempt.startedAtMs),
    startupWatchdogMs: attempt.startupWatchdogMs,
    currentTime: snapshot.currentTime,
    readyState: snapshot.readyState,
    networkState: snapshot.networkState,
    paused: snapshot.paused,
    duration: snapshot.duration,
    bufferedRanges: snapshot.bufferedRanges,
    lastSuccessfulPlaybackEvent: attempt.lastSuccessfulPlaybackEvent,
    lastHlsEvent: attempt.lastHlsEvent,
    staleAttempt: attempt.id !== activeAttemptId,
    watchdogCancelled: attempt.watchdogCancelled,
  };
}
