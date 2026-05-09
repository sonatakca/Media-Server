import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { TranslationKey } from "../../i18n/translations";
import {
  createSyncPlayGroup,
  getSyncPlayGroup,
  joinSyncPlayGroup,
  leaveSyncPlayGroup,
  sendSyncPlayBufferingCommand,
  sendSyncPlayPauseCommand,
  sendSyncPlayPingCommand,
  sendSyncPlayPlayCommand,
  sendSyncPlayReadyCommand,
  sendSyncPlaySeekCommand,
  setSyncPlayNewQueue,
} from "./jellyfinSyncPlayApi";
import { connectJellyfinSyncPlaySocket } from "./jellyfinSyncPlaySocket";
import {
  getCommandDelayMs,
  getExpectedCommandPositionSeconds,
  shouldCorrectSyncPlayDrift,
  ticksFromSeconds,
} from "./partyWatchSync";
import type {
  JellyfinSyncPlayGroupInfo,
  JellyfinSyncPlayGroupState,
  JellyfinSyncPlayGroupStateUpdate,
  JellyfinSyncPlayGroupUpdate,
  JellyfinSyncPlayPlayQueueUpdate,
  JellyfinSyncPlayPlayerStatus,
  JellyfinSyncPlaySendCommand,
  JellyfinSyncPlaySocketMessage,
  JellyfinSyncPlaySocketStatus,
  PartyWatchController,
  PartyWatchRole,
} from "./partyWatchTypes";

interface UsePartyWatchControllerOptions {
  videoRef: RefObject<HTMLVideoElement>;
  itemId: string;
  title: string;
  currentTime: number;
  isPlaying: boolean;
  refreshProgress: () => void;
  showControls: () => void;
}

const REMOTE_APPLY_GUARD_MS = 900;
const MAX_SCHEDULED_COMMAND_DELAY_MS = 15_000;
const SYNCPLAY_PING_INTERVAL_MS = 10_000;
const SYNCPLAY_DRIFT_CHECK_INTERVAL_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeGroupId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function getInviteGroupIdFromLocation(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  return normalizeGroupId(params.get("syncplay") || params.get("party"));
}

function extractGroupIdFromInput(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed, window.location.origin);
    return normalizeGroupId(url.searchParams.get("syncplay") || url.searchParams.get("party") || trimmed);
  } catch {
    return normalizeGroupId(trimmed);
  }
}

function getGroupErrorKey(error: unknown): TranslationKey {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (message.includes("404") || message.includes("not found") || message.includes("does not exist")) {
    return "party.syncPlayGroupNotFound";
  }

  if (message.includes("401") || message.includes("403") || message.includes("forbidden")) {
    return "party.syncPlayUnavailable";
  }

  return "party.syncPlayUnavailable";
}

function getControlErrorKey(error: unknown): TranslationKey {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (message.includes("401") || message.includes("403") || message.includes("forbidden")) {
    return "party.syncPlayHostOnly";
  }

  if (message.includes("not in group") || message.includes("does not exist") || message.includes("404")) {
    return "party.syncPlayGroupNotFound";
  }

  return "party.syncPlayUnavailable";
}

function copyTextWithTextarea(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function getParticipantName(participant: unknown, fallbackIndex: number): string {
  if (typeof participant === "string" && participant.trim()) {
    return participant.trim();
  }

  if (!isRecord(participant)) {
    return `Katılımcı ${fallbackIndex + 1}`;
  }

  const possibleName =
    participant.UserName ??
    participant.Username ??
    participant.Name ??
    participant.DeviceName ??
    participant.UserId;

  return typeof possibleName === "string" && possibleName.trim()
    ? possibleName.trim()
    : `Katılımcı ${fallbackIndex + 1}`;
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return copyTextWithTextarea(text);
    }
  }

  return copyTextWithTextarea(text);
}

function asGroupInfo(value: unknown): JellyfinSyncPlayGroupInfo | null {
  if (!isRecord(value)) {
    return null;
  }

  return value as JellyfinSyncPlayGroupInfo;
}

function asGroupUpdate(value: unknown): JellyfinSyncPlayGroupUpdate | null {
  if (!isRecord(value) || typeof value.Type !== "string") {
    return null;
  }

  return value as JellyfinSyncPlayGroupUpdate;
}

function asSendCommand(value: unknown): JellyfinSyncPlaySendCommand | null {
  if (!isRecord(value) || typeof value.Command !== "string") {
    return null;
  }

  return value as JellyfinSyncPlaySendCommand;
}

function asStateUpdate(value: unknown): JellyfinSyncPlayGroupStateUpdate | null {
  if (!isRecord(value)) {
    return null;
  }

  return value as JellyfinSyncPlayGroupStateUpdate;
}

function asPlayQueueUpdate(value: unknown): JellyfinSyncPlayPlayQueueUpdate | null {
  if (!isRecord(value)) {
    return null;
  }

  return value as JellyfinSyncPlayPlayQueueUpdate;
}

function clearInviteParamsFromLocation(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("syncplay");
  url.searchParams.delete("party");
  window.history.replaceState(window.history.state, "", url.toString());
}

export function usePartyWatchController({
  videoRef,
  itemId,
  title,
  currentTime,
  isPlaying,
  refreshProgress,
  showControls,
}: UsePartyWatchControllerOptions): PartyWatchController {
  const initialInviteGroupIdRef = useRef(getInviteGroupIdFromLocation());
  const autoJoinAttemptedRef = useRef(false);
  const groupIdRef = useRef<string | null>(null);
  const groupStateRef = useRef<JellyfinSyncPlayGroupState | null>(null);
  const currentTimeRef = useRef(currentTime);
  const isPlayingRef = useRef(isPlaying);
  const playlistItemIdRef = useRef<string | undefined>(itemId);
  const canControlRef = useRef(true);
  const isApplyingRemoteCommandRef = useRef(false);
  const remoteGuardTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const remoteCommandTimersRef = useRef<Array<ReturnType<typeof window.setTimeout>>>([]);
  const lastRemotePlayCommandRef = useRef<JellyfinSyncPlaySendCommand | null>(null);
  const pingEstimateMsRef = useRef(150);
  const copyStatusTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const previousParticipantNamesRef = useRef<string[]>([]);
  const partyEventTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const playPauseAnimationIdRef = useRef(0);
  const activePlayPauseAnimationRef = useRef<{
    id: number;
    target: "playing" | "paused";
    startedAt: number;
  } | null>(null);
  const remotePlayPauseApplyTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const [groupInfo, setGroupInfo] = useState<JellyfinSyncPlayGroupInfo | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [joinInput, setJoinInput] = useState(initialInviteGroupIdRef.current ?? "");
  const [role, setRole] = useState<PartyWatchRole | null>(null);
  const [canControl, setCanControl] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isApplyingRemoteCommand, setIsApplyingRemoteCommand] = useState(false);
  const [socketStatus, setSocketStatus] = useState<JellyfinSyncPlaySocketStatus>("disconnected");
  const [isPlayPausePending, setIsPlayPausePending] = useState(false);
  const [isResumePending, setIsResumePending] = useState(false);
  const [pendingPlayPauseTarget, setPendingPlayPauseTarget] = useState<"playing" | "paused" | null>(null);
  const [statusKey, setStatusKey] = useState<TranslationKey | null>(null);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [copyStatusKey, setCopyStatusKey] = useState<TranslationKey | null>(null);
  const [partyEventMessage, setPartyEventMessage] = useState<string | null>(null);

  const isAvailable = useMemo(() => typeof WebSocket !== "undefined", []);
  const isInGroup = Boolean(groupId);
  const shouldDeferAutoplay = Boolean(initialInviteGroupIdRef.current);

  const inviteUrl = useMemo(() => {
    if (!groupId || typeof window === "undefined") {
      return null;
    }

    return `${window.location.origin}/watch/${encodeURIComponent(itemId)}?syncplay=${encodeURIComponent(groupId)}`;
  }, [groupId, itemId]);

  const participantCount = groupInfo?.Participants?.length ?? null;
  const participantNames = groupInfo?.Participants?.map(getParticipantName) ?? [];
  const groupName = groupInfo?.GroupName ?? (groupId ? `SyncPlay ${groupId.slice(0, 8)}` : null);
  const groupState = groupInfo?.State ?? groupStateRef.current;

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    const active = activePlayPauseAnimationRef.current;

    if (!active || !pendingPlayPauseTarget) {
      return;
    }

    const reachedTarget =
      (active.target === "playing" && isPlaying) ||
      (active.target === "paused" && !isPlaying);

    if (!reachedTarget) {
      return;
    }

    activePlayPauseAnimationRef.current = null;
    setPendingPlayPauseTarget(null);
    setIsResumePending(false);
    setIsPlayPausePending(false);
  }, [isPlaying, pendingPlayPauseTarget]);

  useEffect(() => {
    groupIdRef.current = groupId;
  }, [groupId]);

  useEffect(() => {
    groupStateRef.current = groupState ?? null;
  }, [groupState]);

  useEffect(() => {
    canControlRef.current = canControl;
  }, [canControl]);

  const showPartyEventMessage = useCallback((message: string) => {
    setPartyEventMessage(message);

    if (partyEventTimeoutRef.current !== null) {
      window.clearTimeout(partyEventTimeoutRef.current);
    }

    partyEventTimeoutRef.current = window.setTimeout(() => {
      setPartyEventMessage(null);
      partyEventTimeoutRef.current = null;
    }, 3200);
  }, []);

  const applyGroupInfo = useCallback((nextGroupInfo: JellyfinSyncPlayGroupInfo) => {
    const nextParticipantNames = nextGroupInfo.Participants?.map(getParticipantName) ?? [];
    const previousParticipantNames = previousParticipantNamesRef.current;

    if (previousParticipantNames.length > 0 && nextParticipantNames.length !== previousParticipantNames.length) {
      const joinedNames = nextParticipantNames.filter((name) => !previousParticipantNames.includes(name));
      const leftNames = previousParticipantNames.filter((name) => !nextParticipantNames.includes(name));

      if (joinedNames.length > 0) {
        showPartyEventMessage(`${joinedNames[0]} katıldı`);
      } else if (leftNames.length > 0) {
        showPartyEventMessage(`${leftNames[0]} ayrıldı`);
      }
    }

    previousParticipantNamesRef.current = nextParticipantNames;
    setGroupInfo(nextGroupInfo);

    if (nextGroupInfo.GroupId) {
      setGroupId(nextGroupInfo.GroupId);
      groupIdRef.current = nextGroupInfo.GroupId;
    }

    if (nextGroupInfo.State) {
      groupStateRef.current = nextGroupInfo.State;
    }
  }, [showPartyEventMessage]);

  const clearGroupState = useCallback(() => {
    groupIdRef.current = null;
    groupStateRef.current = null;
    lastRemotePlayCommandRef.current = null;
    playlistItemIdRef.current = itemId;
    previousParticipantNamesRef.current = [];

    setGroupId(null);
    setGroupInfo(null);
    setRole(null);
    setCanControl(true);
    setErrorKey(null);
    setPartyEventMessage(null);
  }, [itemId]);

  const refreshGroupInfo = useCallback(
    async (nextGroupId = groupIdRef.current) => {
      if (!nextGroupId) {
        return;
      }

      try {
        const nextGroupInfo = await getSyncPlayGroup(nextGroupId);

        if (groupIdRef.current === nextGroupId) {
          applyGroupInfo(nextGroupInfo);
        }
      } catch (error) {
        const nextErrorKey = getGroupErrorKey(error);

        if (nextErrorKey === "party.syncPlayGroupNotFound") {
          clearGroupState();
        }

        setErrorKey(nextErrorKey);
      }
    },
    [applyGroupInfo, clearGroupState],
  );

  const readPlayerStatus = useCallback((): JellyfinSyncPlayPlayerStatus => {
    const video = videoRef.current;
    const positionSeconds = video?.currentTime ?? currentTimeRef.current;
    const playbackIsActive = video ? !video.paused && !video.ended : isPlayingRef.current;

    return {
      when: new Date().toISOString(),
      positionTicks: ticksFromSeconds(positionSeconds),
      isPlaying: playbackIsActive,
      playlistItemId: playlistItemIdRef.current ?? itemId,
    };
  }, [itemId, videoRef]);

  const markApplyingRemoteCommand = useCallback(() => {
    isApplyingRemoteCommandRef.current = true;
    setIsApplyingRemoteCommand(true);

    if (remoteGuardTimeoutRef.current !== null) {
      window.clearTimeout(remoteGuardTimeoutRef.current);
    }

    remoteGuardTimeoutRef.current = window.setTimeout(() => {
      isApplyingRemoteCommandRef.current = false;
      setIsApplyingRemoteCommand(false);
      remoteGuardTimeoutRef.current = null;
    }, REMOTE_APPLY_GUARD_MS);
  }, []);

  const seekVideoLocally = useCallback(
    (seconds: number) => {
      const video = videoRef.current;

      if (!video) {
        return;
      }

      const duration = Number.isFinite(video.duration) ? video.duration : seconds;
      video.currentTime = Math.min(Math.max(0, seconds), Math.max(0, duration));
      refreshProgress();
    },
    [refreshProgress, videoRef],
  );

  const playVideoLocally = useCallback(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    void video.play().catch((error: unknown) => {
      console.warn("[Seyirlik SyncPlay] video.play() was blocked or failed", error);
    });
    refreshProgress();
  }, [refreshProgress, videoRef]);

  const pauseVideoLocally = useCallback(() => {
    videoRef.current?.pause();
    refreshProgress();
  }, [refreshProgress, videoRef]);

  const beginPlayPauseAnimation = useCallback((target: "playing" | "paused") => {
    const now = Date.now();
    const active = activePlayPauseAnimationRef.current;

    if (active && active.target === target && now - active.startedAt < 2500) {
      return active.id;
    }

    playPauseAnimationIdRef.current += 1;

    const nextAnimation = {
      id: playPauseAnimationIdRef.current,
      target,
      startedAt: now,
    };

    activePlayPauseAnimationRef.current = nextAnimation;
    setPendingPlayPauseTarget(target);
    setIsPlayPausePending(true);

    if (target === "playing") {
      setIsResumePending(true);
    }

    return nextAnimation.id;
  }, []);

  const applyRemoteCommand = useCallback(
    (command: JellyfinSyncPlaySendCommand) => {
      const activeGroupId = groupIdRef.current;

      if (command.GroupId && activeGroupId && command.GroupId !== activeGroupId) {
        return;
      }

      if (command.PlaylistItemId) {
        playlistItemIdRef.current = command.PlaylistItemId;
      }

      const delayMs = Math.min(getCommandDelayMs(command), MAX_SCHEDULED_COMMAND_DELAY_MS);
      const timer = window.setTimeout(() => {
        const video = videoRef.current;

        if (!video) {
          return;
        }

        markApplyingRemoteCommand();

        const targetSeconds = getExpectedCommandPositionSeconds(command);

        if (targetSeconds !== null && Math.abs(video.currentTime - targetSeconds) > 0.35) {
          seekVideoLocally(targetSeconds);
        }

        if (command.Command === "Pause" || command.Command === "Stop") {
          const animationId = beginPlayPauseAnimation("paused");

          if (remotePlayPauseApplyTimeoutRef.current !== null) {
            window.clearTimeout(remotePlayPauseApplyTimeoutRef.current);
          }

          remotePlayPauseApplyTimeoutRef.current = window.setTimeout(() => {
            const active = activePlayPauseAnimationRef.current;

            if (!active || active.id !== animationId || active.target !== "paused") {
              return;
            }

            pauseVideoLocally();
            lastRemotePlayCommandRef.current = null;
            remotePlayPauseApplyTimeoutRef.current = null;
          }, 180);
        } else if (command.Command === "Unpause") {
          const animationId = beginPlayPauseAnimation("playing");

          lastRemotePlayCommandRef.current = {
            ...command,
            When: command.When ?? new Date().toISOString(),
            PositionTicks: command.PositionTicks ?? ticksFromSeconds(video.currentTime),
          };

          if (remotePlayPauseApplyTimeoutRef.current !== null) {
            window.clearTimeout(remotePlayPauseApplyTimeoutRef.current);
          }

          remotePlayPauseApplyTimeoutRef.current = window.setTimeout(() => {
            const active = activePlayPauseAnimationRef.current;

            if (!active || active.id !== animationId || active.target !== "playing") {
              return;
            }

            playVideoLocally();
            remotePlayPauseApplyTimeoutRef.current = null;
          }, 180);
        } else if (command.Command === "Seek") {
          if (groupStateRef.current === "Playing" || !video.paused) {
            lastRemotePlayCommandRef.current = {
              ...command,
              Command: "Unpause",
              When: command.When ?? new Date().toISOString(),
            };
          }
        }

        showControls();
        refreshProgress();
        setStatusKey("party.syncingWithJellyfinSyncPlay");
      }, delayMs);

      remoteCommandTimersRef.current.push(timer);
    },
    [
      beginPlayPauseAnimation,
      markApplyingRemoteCommand,
      pauseVideoLocally,
      playVideoLocally,
      refreshProgress,
      seekVideoLocally,
      showControls,
      videoRef,
    ],
  );

  const handlePlayQueueUpdate = useCallback(
    (update: JellyfinSyncPlayGroupUpdate) => {
      const queueUpdate = asPlayQueueUpdate(update.Data);

      if (!queueUpdate) {
        return;
      }

      const playingItem =
        typeof queueUpdate.PlayingItemIndex === "number"
          ? queueUpdate.Playlist?.[queueUpdate.PlayingItemIndex]
          : undefined;

      if (playingItem?.PlaylistItemId) {
        playlistItemIdRef.current = playingItem.PlaylistItemId;
      }

      if (typeof queueUpdate.StartPositionTicks !== "number") {
        return;
      }

      applyRemoteCommand({
        GroupId: update.GroupId ?? groupIdRef.current ?? undefined,
        PlaylistItemId: playingItem?.PlaylistItemId,
        When: queueUpdate.LastUpdate,
        PositionTicks: queueUpdate.StartPositionTicks,
        Command: queueUpdate.IsPlaying ? "Unpause" : "Pause",
      });
    },
    [applyRemoteCommand],
  );

  const handleGroupUpdate = useCallback(
    (update: JellyfinSyncPlayGroupUpdate) => {
      const activeGroupId = groupIdRef.current;

      if (update.GroupId && activeGroupId && update.GroupId !== activeGroupId) {
        return;
      }

      if (update.Type === "GroupJoined") {
        const nextGroupInfo = asGroupInfo(update.Data);

        if (nextGroupInfo) {
          applyGroupInfo(nextGroupInfo);
        }

        setStatusKey("party.joinedSyncPlayGroup");
        setErrorKey(null);
        return;
      }

      if (update.Type === "GroupLeft" || update.Type === "NotInGroup") {
        clearGroupState();
        setStatusKey("party.leftSyncPlayGroup");
        return;
      }

      if (update.Type === "GroupDoesNotExist") {
        clearGroupState();
        setErrorKey("party.syncPlayGroupNotFound");
        return;
      }

      if (update.Type === "LibraryAccessDenied") {
        setErrorKey("party.syncPlayUnavailable");
        return;
      }

      if (update.Type === "UserJoined" || update.Type === "UserLeft") {
        void refreshGroupInfo(update.GroupId ?? activeGroupId);
        return;
      }

      if (update.Type === "StateUpdate") {
        const stateUpdate = asStateUpdate(update.Data);

        if (stateUpdate?.State) {
          groupStateRef.current = stateUpdate.State;
          setGroupInfo((currentGroupInfo) =>
            currentGroupInfo ? { ...currentGroupInfo, State: stateUpdate.State } : currentGroupInfo,
          );
        }

        setStatusKey("party.syncingWithJellyfinSyncPlay");
        return;
      }

      if (update.Type === "PlayQueue") {
        handlePlayQueueUpdate(update);
        void refreshGroupInfo(update.GroupId ?? activeGroupId);
      }
    },
    [applyGroupInfo, clearGroupState, handlePlayQueueUpdate, refreshGroupInfo],
  );

  const handleSocketMessage = useCallback(
    (message: JellyfinSyncPlaySocketMessage) => {
      if (message.MessageType === "SyncPlayCommand") {
        const command = asSendCommand(message.Data);

        if (command) {
          applyRemoteCommand(command);
        }

        return;
      }

      if (message.MessageType === "SyncPlayGroupUpdate") {
        const update = asGroupUpdate(message.Data);

        if (update) {
          handleGroupUpdate(update);
        }
      }
    },
    [applyRemoteCommand, handleGroupUpdate],
  );

  useEffect(() => {
    if (!isAvailable) {
      setErrorKey("party.syncPlayUnavailable");
      return undefined;
    }

    const connection = connectJellyfinSyncPlaySocket({
      onMessage: handleSocketMessage,
      onStatus: setSocketStatus,
      onError: () => setErrorKey("party.syncPlayUnavailable"),
    });

    return () => {
      connection.close();
    };
  }, [handleSocketMessage, isAvailable]);

  const sendReadyStatus = useCallback(async () => {
    if (!groupIdRef.current) {
      return;
    }

    await sendSyncPlayReadyCommand(readPlayerStatus());
  }, [readPlayerStatus]);

  const createGroup = useCallback(async () => {
    if (isLoading) {
      return;
    }

    setIsLoading(true);
    setErrorKey(null);
    setStatusKey(null);

    try {
      const status = readPlayerStatus();
      const newGroupInfo = await createSyncPlayGroup(`Seyirlik - ${title}`);

      if (!newGroupInfo.GroupId) {
        throw new Error("Jellyfin did not return a SyncPlay group id.");
      }

      applyGroupInfo(newGroupInfo);
      setRole("host");
      setCanControl(true);
      setStatusKey("party.createdSyncPlayGroup");
      await setSyncPlayNewQueue({
        itemId,
        startPositionTicks: status.positionTicks,
      });
      await sendSyncPlayReadyCommand(status);

      if (status.isPlaying) {
        await sendSyncPlayPlayCommand();
      }

      void refreshGroupInfo(newGroupInfo.GroupId);
    } catch (error) {
      setErrorKey(getGroupErrorKey(error));
    } finally {
      setIsLoading(false);
    }
  }, [applyGroupInfo, isLoading, itemId, readPlayerStatus, refreshGroupInfo, title]);

  const joinGroup = useCallback(
    async (requestedGroupId?: string) => {
      if (isLoading) {
        return;
      }

      const nextGroupId = extractGroupIdFromInput(requestedGroupId ?? joinInput);

      if (!nextGroupId) {
        return;
      }

      setIsLoading(true);
      setErrorKey(null);
      setStatusKey(null);

      try {
        const existingGroupInfo = await getSyncPlayGroup(nextGroupId);
        await joinSyncPlayGroup(nextGroupId);
        applyGroupInfo({
          ...existingGroupInfo,
          GroupId: existingGroupInfo.GroupId ?? nextGroupId,
        });
        setRole("member");
        setCanControl(true);
        setJoinInput(nextGroupId);
        setStatusKey("party.joinedSyncPlayGroup");
        await sendSyncPlayReadyCommand(readPlayerStatus());
        void refreshGroupInfo(nextGroupId);
      } catch (error) {
        setErrorKey(getGroupErrorKey(error));
      } finally {
        autoJoinAttemptedRef.current = true;
        setIsLoading(false);
      }
    },
    [applyGroupInfo, isLoading, joinInput, readPlayerStatus, refreshGroupInfo],
  );

  const leaveGroup = useCallback(async () => {
    if (!groupIdRef.current || isLoading) {
      return;
    }

    setIsLoading(true);
    setErrorKey(null);

    try {
      await leaveSyncPlayGroup();
      clearGroupState();
      clearInviteParamsFromLocation();
      setStatusKey("party.leftSyncPlayGroup");
    } catch (error) {
      setErrorKey(getGroupErrorKey(error));
    } finally {
      setIsLoading(false);
    }
  }, [clearGroupState, isLoading]);

  const copyInvite = useCallback(async () => {
    if (!inviteUrl) {
      return;
    }

    if (copyStatusTimeoutRef.current !== null) {
      window.clearTimeout(copyStatusTimeoutRef.current);
    }

    const didCopy = await copyText(inviteUrl);
    setCopyStatusKey(didCopy ? "party.inviteCopied" : "party.copyFailed");

    copyStatusTimeoutRef.current = window.setTimeout(() => {
      setCopyStatusKey(null);
      copyStatusTimeoutRef.current = null;
    }, 2500);
  }, [inviteUrl]);

  const runSyncPlayControl = useCallback(
    async (
      control: () => Promise<void>,
      options?: {
        resumePending?: boolean;
        playPausePending?: boolean;
      },
    ) => {
      if (!canControlRef.current) {
        setErrorKey("party.syncPlayHostOnly");
        return;
      }

      if (options?.resumePending) {
        setIsResumePending(true);
      }

      if (options?.playPausePending) {
        setIsPlayPausePending(true);
      }

      try {
        setErrorKey(null);
        await control();
        setStatusKey("party.syncingWithJellyfinSyncPlay");
      } catch (error) {
        const nextErrorKey = getControlErrorKey(error);
        setErrorKey(nextErrorKey);

        if (nextErrorKey === "party.syncPlayHostOnly") {
          setCanControl(false);
        }

        if (options?.resumePending) {
          setIsResumePending(false);
        }

        if (options?.playPausePending) {
          setIsPlayPausePending(false);
        }

        setPendingPlayPauseTarget(null);
      }
    },
    [],
  );

  const togglePlay = useCallback(() => {
    if (isApplyingRemoteCommandRef.current) {
      return;
    }

    const activeGroupId = groupIdRef.current;
    const video = videoRef.current;

    if (!activeGroupId) {
      if (video?.paused) {
        playVideoLocally();
      } else {
        pauseVideoLocally();
      }
      return;
    }

    const status = readPlayerStatus();
    const nextTarget = status.isPlaying ? "paused" : "playing";
    const isResumeAction = nextTarget === "playing";

    beginPlayPauseAnimation(nextTarget);

    void runSyncPlayControl(
      async () => {
        await sendReadyStatus().catch(() => undefined);

        if (status.isPlaying) {
          await sendSyncPlayPauseCommand();
        } else {
          await sendSyncPlayPlayCommand();
        }
      },
      {
        resumePending: isResumeAction,
        playPausePending: true,
      },
    );
  }, [beginPlayPauseAnimation, pauseVideoLocally, playVideoLocally, readPlayerStatus, runSyncPlayControl, sendReadyStatus, videoRef]);

  const seekTo = useCallback(
    (seconds: number) => {
      if (isApplyingRemoteCommandRef.current) {
        return;
      }

      const activeGroupId = groupIdRef.current;

      if (!activeGroupId) {
        seekVideoLocally(seconds);
        return;
      }

      void runSyncPlayControl(async () => {
        await sendSyncPlaySeekCommand(ticksFromSeconds(seconds));
      });
    },
    [runSyncPlayControl, seekVideoLocally],
  );

  const seekBy = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      seekTo((video?.currentTime ?? currentTimeRef.current) + seconds);
    },
    [seekTo, videoRef],
  );

  useEffect(() => {
    const invitedGroupId = initialInviteGroupIdRef.current;

    if (!invitedGroupId || autoJoinAttemptedRef.current) {
      return;
    }

    autoJoinAttemptedRef.current = true;
    void joinGroup(invitedGroupId);
  }, [joinGroup]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    let lastBufferingReportAt = 0;
    let lastReadyReportAt = 0;

    const sendStatus = (type: "buffering" | "ready") => {
      if (!groupIdRef.current) {
        return;
      }

      const now = Date.now();

      if (type === "buffering") {
        if (now - lastBufferingReportAt < 1000) {
          return;
        }
        lastBufferingReportAt = now;
        void sendSyncPlayBufferingCommand(readPlayerStatus()).catch(() => undefined);
      } else {
        if (now - lastReadyReportAt < 800) {
          return;
        }
        lastReadyReportAt = now;
        void sendSyncPlayReadyCommand(readPlayerStatus()).catch(() => undefined);
      }
    };

    const handleBuffering = () => sendStatus("buffering");
    const handleReady = () => sendStatus("ready");

    video.addEventListener("waiting", handleBuffering);
    video.addEventListener("stalled", handleBuffering);
    video.addEventListener("canplay", handleReady);
    video.addEventListener("playing", handleReady);

    return () => {
      video.removeEventListener("waiting", handleBuffering);
      video.removeEventListener("stalled", handleBuffering);
      video.removeEventListener("canplay", handleReady);
      video.removeEventListener("playing", handleReady);
    };
  }, [readPlayerStatus, videoRef]);

  useEffect(() => {
    if (!groupId) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      const startedAt = performance.now();

      void sendSyncPlayPingCommand(pingEstimateMsRef.current)
        .then(() => {
          pingEstimateMsRef.current = Math.max(1, performance.now() - startedAt);
        })
        .catch(() => undefined);
    }, SYNCPLAY_PING_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [groupId]);

  useEffect(() => {
    if (!groupId) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      const command = lastRemotePlayCommandRef.current;
      const video = videoRef.current;

      if (!command || !video || video.paused || video.seeking) {
        return;
      }

      const expectedSeconds = getExpectedCommandPositionSeconds(command);

      if (expectedSeconds !== null && shouldCorrectSyncPlayDrift(video.currentTime, expectedSeconds)) {
        markApplyingRemoteCommand();
        seekVideoLocally(expectedSeconds);
      }
    }, SYNCPLAY_DRIFT_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [groupId, markApplyingRemoteCommand, seekVideoLocally, videoRef]);

  useEffect(() => {
    return () => {
      if (groupIdRef.current) {
        void leaveSyncPlayGroup().catch(() => undefined);
      }

      if (remoteGuardTimeoutRef.current !== null) {
        window.clearTimeout(remoteGuardTimeoutRef.current);
      }

      if (copyStatusTimeoutRef.current !== null) {
        window.clearTimeout(copyStatusTimeoutRef.current);
      }

      if (partyEventTimeoutRef.current !== null) {
        window.clearTimeout(partyEventTimeoutRef.current);
      }

      if (remotePlayPauseApplyTimeoutRef.current !== null) {
        window.clearTimeout(remotePlayPauseApplyTimeoutRef.current);
      }

      remoteCommandTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      remoteCommandTimersRef.current = [];
    };
  }, []);

  return {
    isAvailable,
    isLoading,
    isInGroup,
    isApplyingRemoteCommand,
    isResumePending,
    isPlayPausePending,
    shouldDeferAutoplay,
    groupId,
    groupName,
    groupState,
    joinInput,
    inviteUrl,
    participantCount,
    participantNames,
    partyEventMessage,
    role,
    canControl,
    socketStatus,
    statusKey,
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
