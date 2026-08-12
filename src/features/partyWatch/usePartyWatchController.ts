import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import { getCachedSession } from "../../lib/authStorage";
import {
  closePartyWatchGroup,
  connectPartyWatchStream,
  createPartyWatchGroup,
  getPartyWatchGroup,
  joinPartyWatchGroup,
  leavePartyWatchGroup,
  reportPartyWatchStatus,
  sendPartyWatchPause,
  sendPartyWatchPlay,
  sendPartyWatchSeek,
  type PartyWatchGroup,
  type PartyWatchStream,
  type PartyWatchStreamStatus,
} from "./partyWatchApi";
import { SYNCPLAY_DRIFT_CORRECTION_THRESHOLD_SECONDS } from "./partyWatchSync";
import type {
  PartyWatchController,
  PartyWatchRole,
  SyncPlayGroupState,
  SyncPlaySocketStatus,
} from "./partyWatchTypes";

/**
 * Party Watch, over Seyirlik's own SyncPlay.
 *
 * The server owns the timeline and every message carries the complete state, so
 * this controller has no command log to replay and no message taxonomy to
 * reduce: it applies whatever the last state said and reports what the local
 * player is doing. That is why it is a fraction of the size of the protocol it
 * replaces.
 */

interface UsePartyWatchControllerOptions {
  videoRef: RefObject<HTMLVideoElement>;
  itemId: string;
  title: string;
  currentTime: number;
  isPlaying: boolean;
  refreshProgress: () => void;
  showControls: () => void;
}

/** Ignore our own player events while a remote command is being applied. */
const REMOTE_APPLY_GUARD_MS = 900;
const STATUS_REPORT_INTERVAL_MS = 5_000;

function normalizeGroupId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && /^[0-9a-f-]{36}$/i.test(trimmed) ? trimmed : null;
}

function getInviteGroupIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return normalizeGroupId(params.get("party") || params.get("syncplay"));
}

/** Accepts a bare id or a full invite URL pasted into the join field. */
export function extractGroupIdFromInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const direct = normalizeGroupId(trimmed);
  if (direct) return direct;

  try {
    const url = new URL(trimmed, window.location.origin);
    return normalizeGroupId(
      url.searchParams.get("party") || url.searchParams.get("syncplay"),
    );
  } catch {
    return null;
  }
}

function toGroupState(
  group: PartyWatchGroup | null,
): SyncPlayGroupState | null {
  if (!group) return null;
  if (group.isWaiting) return "Waiting";
  return group.isPlaying ? "Playing" : "Paused";
}

/** Where the group believes playback is, extrapolated to this instant. */
function groupPositionSeconds(group: PartyWatchGroup): number {
  const elapsed = group.isPlaying ? Date.now() - group.serverTimeMs : 0;
  return Math.max(0, (group.positionMs + elapsed) / 1_000);
}

export function usePartyWatchController({
  videoRef,
  itemId,
  currentTime,
  isPlaying,
  refreshProgress,
  showControls,
}: UsePartyWatchControllerOptions): PartyWatchController {
  const { t } = useLanguage();
  const [group, setGroup] = useState<PartyWatchGroup | null>(null);
  const [joinInput, setJoinInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isApplyingRemoteCommand, setIsApplyingRemoteCommand] = useState(false);
  const [streamStatus, setStreamStatus] =
    useState<PartyWatchStreamStatus>("closed");
  const [errorKey, setErrorKey] =
    useState<PartyWatchController["errorKey"]>(null);
  const [copyStatusKey, setCopyStatusKey] =
    useState<PartyWatchController["copyStatusKey"]>(null);
  const [partyEventMessage, setPartyEventMessage] = useState<string | null>(
    null,
  );

  const streamRef = useRef<PartyWatchStream | null>(null);
  const remoteGuardRef = useRef(0);
  const currentTimeRef = useRef(currentTime);
  const isPlayingRef = useRef(isPlaying);
  const autoJoinAttemptedRef = useRef(false);

  currentTimeRef.current = currentTime;
  isPlayingRef.current = isPlaying;

  const groupId = group?.id ?? null;
  const viewerId = getCachedSession()?.userId ?? null;
  const role: PartyWatchRole | null = group
    ? group.ownerUserId === viewerId
      ? "host"
      : "member"
    : null;

  /**
   * Brings the local player in line with the group.
   *
   * Small drift is left alone: correcting it is more disruptive than the drift
   * itself, and every member correcting constantly would fight the others.
   */
  const applyGroupState = useCallback(
    (next: PartyWatchGroup) => {
      const video = videoRef.current;
      if (!video) return;

      const target = groupPositionSeconds(next);
      const drift = Math.abs(video.currentTime - target);

      remoteGuardRef.current = Date.now() + REMOTE_APPLY_GUARD_MS;
      setIsApplyingRemoteCommand(true);

      if (drift > SYNCPLAY_DRIFT_CORRECTION_THRESHOLD_SECONDS) {
        video.currentTime = target;
      }

      if (next.isPlaying && !next.isWaiting && video.paused) {
        void video.play().catch(() => undefined);
      } else if ((!next.isPlaying || next.isWaiting) && !video.paused) {
        video.pause();
      }

      window.setTimeout(() => {
        setIsApplyingRemoteCommand(false);
        refreshProgress();
      }, REMOTE_APPLY_GUARD_MS);
    },
    [refreshProgress, videoRef],
  );

  const disconnect = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
  }, []);

  const connect = useCallback(
    (id: string) => {
      disconnect();
      streamRef.current = connectPartyWatchStream(id, {
        onState: (next) => {
          setGroup(next);
          applyGroupState(next);
        },
        onClosed: () => {
          setGroup(null);
          setPartyEventMessage(t("party.leftSyncPlayGroup"));
          disconnect();
        },
        onStatusChange: setStreamStatus,
      });
    },
    [applyGroupState, disconnect, t],
  );

  useEffect(() => disconnect, [disconnect]);

  const createGroup = useCallback(async () => {
    setIsLoading(true);
    setErrorKey(null);
    try {
      const created = await createPartyWatchGroup({ itemId });
      setGroup(created);
      connect(created.id);
      showControls();
    } catch {
      setErrorKey("party.syncPlayUnavailable");
    } finally {
      setIsLoading(false);
    }
  }, [connect, itemId, showControls]);

  const joinGroup = useCallback(
    async (requestedGroupId?: string) => {
      const target =
        normalizeGroupId(requestedGroupId) ??
        extractGroupIdFromInput(joinInput);
      if (!target) {
        setErrorKey("party.syncPlayGroupNotFound");
        return;
      }

      setIsLoading(true);
      setErrorKey(null);
      try {
        const joined = await joinPartyWatchGroup(target);
        setGroup(joined);
        connect(joined.id);
        showControls();
      } catch {
        setErrorKey("party.syncPlayGroupNotFound");
      } finally {
        setIsLoading(false);
      }
    },
    [connect, joinInput, showControls],
  );

  const leaveGroup = useCallback(async () => {
    if (!groupId) return;

    disconnect();
    const wasHost = role === "host";
    setGroup(null);

    try {
      // The host closing the group is what ends the session for everyone;
      // a member simply leaves.
      if (wasHost) await closePartyWatchGroup(groupId);
      else await leavePartyWatchGroup(groupId);
    } catch {
      setErrorKey("party.syncPlayUnavailable");
    }
  }, [disconnect, groupId, role]);

  // An invite link joins on first load, once.
  useEffect(() => {
    if (autoJoinAttemptedRef.current) return;
    const inviteGroupId = getInviteGroupIdFromLocation();
    if (!inviteGroupId) return;

    autoJoinAttemptedRef.current = true;
    void joinGroup(inviteGroupId);
  }, [joinGroup]);

  // Report position and buffering so the group can wait for whoever is behind.
  useEffect(() => {
    if (!groupId) return;

    const report = () => {
      const video = videoRef.current;
      void reportPartyWatchStatus(groupId, {
        positionMs: Math.round(currentTimeRef.current * 1_000),
        isReady: true,
        isBuffering: video ? video.readyState < 3 : false,
      }).catch(() => undefined);
    };

    report();
    const interval = window.setInterval(report, STATUS_REPORT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [groupId, videoRef]);

  const isRemoteApplyInFlight = useCallback(
    () => Date.now() < remoteGuardRef.current,
    [],
  );

  /**
   * Solo playback: there is no group to command, so the element is driven
   * directly.
   *
   * Every player control routes through this controller, so without these the
   * pause and seek buttons do nothing at all whenever the viewer is not in a
   * party — which is nearly always.
   */
  const toggleLocalPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [videoRef]);

  const seekLocalTo = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;

      // `duration` is NaN until metadata arrives; clamping against it then
      // would put the position at NaN and lose the viewer's place.
      const duration = video.duration;
      const upperBound =
        Number.isFinite(duration) && duration > 0 ? duration - 0.25 : undefined;
      const target = Math.max(
        0,
        upperBound === undefined ? seconds : Math.min(seconds, upperBound),
      );
      video.currentTime = target;
      refreshProgress();
    },
    [refreshProgress, videoRef],
  );

  const togglePlay = useCallback(() => {
    if (isRemoteApplyInFlight()) return;
    if (!groupId) {
      toggleLocalPlay();
      return;
    }

    const positionMs = Math.round(currentTimeRef.current * 1_000);
    void (
      isPlayingRef.current
        ? sendPartyWatchPause(groupId, positionMs)
        : sendPartyWatchPlay(groupId, positionMs)
    )
      .then((next) => {
        if (next) setGroup(next);
      })
      .catch(() => setErrorKey("party.syncPlayUnavailable"));
  }, [groupId, isRemoteApplyInFlight, toggleLocalPlay]);

  const seekTo = useCallback(
    (seconds: number) => {
      if (isRemoteApplyInFlight()) return;
      if (!groupId) {
        seekLocalTo(seconds);
        return;
      }

      void sendPartyWatchSeek(groupId, Math.max(0, Math.round(seconds * 1_000)))
        .then((next) => {
          if (next) setGroup(next);
        })
        .catch(() => setErrorKey("party.syncPlayUnavailable"));
    },
    [groupId, isRemoteApplyInFlight, seekLocalTo],
  );

  const seekBy = useCallback(
    (seconds: number) => seekTo(currentTimeRef.current + seconds),
    [seekTo],
  );

  const inviteUrl = useMemo(() => {
    if (!groupId || typeof window === "undefined") return null;
    const url = new URL(window.location.href);
    url.searchParams.set("party", groupId);
    return url.toString();
  }, [groupId]);

  const copyInvite = useCallback(async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopyStatusKey("party.inviteCopied");
    } catch {
      setCopyStatusKey("party.copyFailed");
    }
  }, [inviteUrl]);

  // Refresh once on mount if a group was already open in this tab.
  useEffect(() => {
    if (!groupId || group) return;
    void getPartyWatchGroup(groupId)
      .then(setGroup)
      .catch(() => undefined);
  }, [group, groupId]);

  const socketStatus: SyncPlaySocketStatus =
    streamStatus === "connected"
      ? "connected"
      : streamStatus === "connecting" || streamStatus === "reconnecting"
        ? "connecting"
        : "disconnected";

  return {
    isAvailable: true,
    isLoading,
    isInGroup: group !== null,
    isApplyingRemoteCommand,
    isResumePending: group?.isWaiting === true,
    isPlayPausePending: isLoading,
    // Autoplay must not start before the group says so, or a joiner races ahead.
    shouldDeferAutoplay: group !== null && !group.isPlaying,
    groupId,
    groupName: group?.name ?? null,
    groupState: toGroupState(group),
    joinInput,
    inviteUrl,
    participantCount: group?.members.length ?? null,
    participantNames: group?.members.map((member) => member.displayName) ?? [],
    partyEventMessage,
    role,
    // Anyone in the group can drive it; the server orders the commands.
    canControl: group !== null,
    socketStatus,
    statusKey: group?.isWaiting ? "party.socketConnecting" : null,
    errorKey,
    copyStatusKey,
    setJoinInput,
    createGroup,
    joinGroup,
    leaveGroup,
    copyInvite,
    togglePlay,
    seekTo,
    seekBy,
  };
}
