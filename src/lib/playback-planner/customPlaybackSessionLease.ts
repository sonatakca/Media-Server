import { useEffect } from "react";
import type { PlaybackSourceCandidate } from "../types";
import {
  isCustomPlaybackCandidate,
  stopCustomPlaybackSession,
} from "./customPlaybackApi";

const DEFAULT_RELEASE_GRACE_MS = 750;

interface SessionLease {
  source: PlaybackSourceCandidate;
  retainCount: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
}

const leasesBySessionId = new Map<string, SessionLease>();
const stoppedSessionIds = new Set<string>();

function getCustomSessionId(
  source: PlaybackSourceCandidate | null | undefined,
): string | null {
  if (!source?.playSessionId || !isCustomPlaybackCandidate(source)) {
    return null;
  }

  return source.playSessionId;
}

function safeSessionLabel(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 12)}...`;
}

function logLeaseEvent(sessionId: string, event: string): void {
  console.info(
    `[Seyirlik Playback] Custom session ${safeSessionLabel(
      sessionId,
    )} ${event}.`,
  );
}

function clearPendingStop(lease: SessionLease): void {
  if (!lease.stopTimer) {
    return;
  }

  clearTimeout(lease.stopTimer);
  lease.stopTimer = null;
}

export function retainCustomPlaybackSession(
  source: PlaybackSourceCandidate | null | undefined,
): void {
  const sessionId = getCustomSessionId(source);

  if (!sessionId || !source) {
    return;
  }

  const lease = leasesBySessionId.get(sessionId) ?? {
    source,
    retainCount: 0,
    stopTimer: null,
    stopping: false,
  };
  const hadPendingStop = Boolean(lease.stopTimer);

  stoppedSessionIds.delete(sessionId);
  clearPendingStop(lease);
  lease.source = source;
  lease.retainCount += 1;
  leasesBySessionId.set(sessionId, lease);

  logLeaseEvent(sessionId, hadPendingStop ? "release cancelled" : "retained");
}

export function releaseCustomPlaybackSession(
  source: PlaybackSourceCandidate | null | undefined,
  options: { graceMs?: number } = {},
): void {
  const sessionId = getCustomSessionId(source);

  if (!sessionId || !source) {
    return;
  }

  if (stoppedSessionIds.has(sessionId)) {
    return;
  }

  const lease = leasesBySessionId.get(sessionId) ?? {
    source,
    retainCount: 0,
    stopTimer: null,
    stopping: false,
  };

  lease.source = source;
  lease.retainCount = Math.max(0, lease.retainCount - 1);
  leasesBySessionId.set(sessionId, lease);

  if (lease.retainCount > 0 || lease.stopTimer || lease.stopping) {
    return;
  }

  logLeaseEvent(sessionId, "release scheduled");
  lease.stopTimer = setTimeout(() => {
    const currentLease = leasesBySessionId.get(sessionId);

    if (
      !currentLease ||
      currentLease.retainCount > 0 ||
      currentLease.stopping
    ) {
      return;
    }

    currentLease.stopTimer = null;
    currentLease.stopping = true;

    void stopCustomPlaybackSession(currentLease.source).finally(() => {
      stoppedSessionIds.add(sessionId);

      const latestLease = leasesBySessionId.get(sessionId);

      if (latestLease === currentLease) {
        leasesBySessionId.delete(sessionId);
      }
    });
  }, options.graceMs ?? DEFAULT_RELEASE_GRACE_MS);
}

export async function stopCustomPlaybackSessionImmediately(
  source: PlaybackSourceCandidate | null | undefined,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  const sessionId = getCustomSessionId(source);

  if (!sessionId || !source) {
    return;
  }

  const lease = leasesBySessionId.get(sessionId);

  if (lease) {
    clearPendingStop(lease);
    leasesBySessionId.delete(sessionId);
  }

  try {
    await stopCustomPlaybackSession(source, options);
  } finally {
    stoppedSessionIds.add(sessionId);
  }
}

export function useCustomPlaybackSessionLease(
  source: PlaybackSourceCandidate | null | undefined,
): void {
  const sourceId = source?.id;
  const playSessionId = source?.playSessionId;

  useEffect(() => {
    if (!source || !sourceId || !playSessionId) {
      return undefined;
    }

    retainCustomPlaybackSession(source);
    return () => {
      releaseCustomPlaybackSession(source);
    };
  }, [sourceId, playSessionId]);
}

export function resetCustomPlaybackSessionLeasesForTests(): void {
  for (const lease of leasesBySessionId.values()) {
    clearPendingStop(lease);
  }

  leasesBySessionId.clear();
  stoppedSessionIds.clear();
}
