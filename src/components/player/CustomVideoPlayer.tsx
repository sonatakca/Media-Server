import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Bookmark, Eye, EyeOff, Users } from "lucide-react";
import {
  buildConfiguredHlsPlaybackSource,
  buildSubtitleStreamUrl,
  getLogoImageUrl,
  getManualQualityOptions,
  getItemTrickplayImageUrl,
  getActiveTranscodingReasons,
  redactPlaybackUrl,
  stopActiveTranscodeSession,
} from "../../lib/mediaApi";
import { isCustomPlaybackCandidate } from "../../lib/playback-planner/customPlaybackApi";
import {
  stopCustomPlaybackSessionImmediately,
  useCustomPlaybackSessionLease,
} from "../../lib/playback-planner/customPlaybackSessionLease";
import { attachSourceToVideo } from "../../lib/videoSource";
import type { AttachedVideoSource } from "../../lib/videoSource";
import type {
  AvailableQualityFile,
  QualityPreferenceMode,
} from "../../renditions/contracts";
import { getCachedSession } from "../../lib/authStorage";
import {
  formatTemplate,
  getDisplayTitle,
  getItemSubtitle,
} from "../../lib/format";
import { getMediaOwnerRouteForItem } from "../../lib/routes";
import { getEpisodeDisplayMetadata } from "../../lib/episodeMetadataPreferences";
import {
  getItemDisplayMetadata,
  getItemLogoUrlById,
} from "../../lib/itemMetadataPreferences";
import { getVideoErrorDetails } from "../../hooks/usePlaybackSource";
import { useAutoHideControls } from "../../hooks/useAutoHideControls";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useMediaSegments } from "../../hooks/useMediaSegments";
import { usePlayerProgress } from "../../hooks/usePlayerProgress";
import { useViewportCapabilities } from "../../hooks/useViewportCapabilities";
import { useLanguage } from "../../i18n/LanguageContext";
import type {
  NormalizedMediaSegment,
  PlaybackQualityOption,
  PlaybackSourceCandidate,
  PlaybackSourceSettings,
} from "../../lib/types";
import { PlayerControls } from "./PlayerControls";
import { PlayerErrorOverlay } from "./PlayerErrorOverlay";
import { PlayerOverlay } from "./PlayerOverlay";
import { PlaybackInfoButton } from "./PlaybackInfoButton";
import { PlaybackInfoPanel } from "./PlaybackInfoPanel";
import { NextEpisodeCountdownOverlay } from "./NextEpisodeCountdownOverlay";
import { PartyWatchControls } from "../../features/partyWatch/PartyWatchControls";
import { PartyWatchOverlay } from "../../features/partyWatch/PartyWatchOverlay";
import { usePartyWatchController } from "../../features/partyWatch/usePartyWatchController";
import { SkipSegmentButton } from "./SkipSegmentButton";
import { Tooltip } from "../ui/Tooltip";
import {
  AUTO_QUALITY_ID,
  DEFAULT_NEXT_EPISODE_COUNTDOWN_SECONDS,
  DEFAULT_SUBTITLE_SCALE,
  DEFAULT_VIDEO_ASPECT_RATIO,
  MAX_SUBTITLE_SCALE,
  MIN_SUBTITLE_SCALE,
  PARTY_WATCH_DOT_POSITIONS,
  PLAYBACK_PROGRESS_REPORT_INTERVAL_MS,
  TOUCH_DOUBLE_TAP_THRESHOLD_MS,
  TOUCH_SEEK_SESSION_TIMEOUT_MS,
  TRICKPLAY_COLUMNS,
  TRICKPLAY_IMAGES_PER_SHEET,
  TRICKPLAY_INTERVAL_SECONDS,
  TRICKPLAY_ROWS,
  VIEW_MODE_CURSOR_HIDE_MS,
} from "./constants";
import {
  clamp,
  getSpritePositionPercent,
  getVideoAspectRatioFromElement,
  getVideoAspectRatioFromSource,
} from "./mediaGeometry";
import {
  getNativeActiveAudioStreamIndex,
  getNativeAudioTrackSnapshot,
  tryApplyNativeAudioTrack,
} from "./nativeAudioTracks";
import {
  getPlaybackUrlDebugParams,
  isMasterHlsPlaybackUrl,
  logAudioSourceDebug,
} from "./playbackDebug";
import {
  buildPlaybackStartupDiagnostics,
  createPlaybackAttemptState,
  getFatalPlaybackSuppression,
  getVideoSnapshot,
  hasPlayableBuffer,
  isPlaybackStartupHealthy,
  markStartupWatchdogCancelled,
  recordHlsEvent,
  recordSuccessfulPlaybackEvent,
  shouldExtendStartupWatchdog,
  type PlaybackAttemptState,
  type PlaybackVideoSnapshot,
} from "./playbackStartupGuard";
import {
  getSkipSegmentLabelKey,
  isNextEpisodeSegmentType,
  isSkippableSegmentType,
} from "./segmentUtils";
import {
  canInjectDefaultAudioIntoStreamCopy,
  didUserSelectNonDefaultAudio,
  getAudioFallbackSource,
  getDefaultAudioStreamIndex,
  getDefaultSubtitleStreamIndex,
  getMediaSourceDefaultAudioStreamIndex,
  getQualitySettings,
  getStreamByIndex,
  getStreamsOfType,
  isAudioTranscodeSource,
  isDirectBrowserPlaybackSource,
  isVideoReadyForAudioTranscodePlayback,
  shouldForceDefaultAudioInPlaybackUrl,
} from "./streamUtils";
import {
  disableNativeVideoTextTracks,
  getActiveSubtitleTextForTime,
  parseSubtitleCues,
} from "./subtitleUtils";
import type {
  CompleteFileQualityControls,
  CustomVideoPlayerProps,
  PendingAudioTranscodePlay,
  PendingSourceRestore,
  SubtitleCue,
  SubtitleDragState,
  SubtitlePosition,
  SubtitleResizeState,
  SubtitleSize,
  TouchSeekSessionState,
  TouchSeekSide,
} from "./types";
import { ActiveSourceBadge } from "./ActiveSourceBadge";
import { useSeekFeedback } from "./useSeekFeedback";
import {
  HANDOFF_CROSSFADE_MS,
  useSeamlessQualitySwitch,
  type PlaybackIntent,
} from "./useSeamlessQualitySwitch";
import {
  evaluateSeamlessEligibility,
  type DeckId,
  type SwitchDiagnostics,
} from "./deckModel";
import { warmQualityAtPosition } from "./warmQuality";
import { LoadingSpinner } from "../LoadingSpinner";
import {
  displayTargetHeight,
  isQualityAudioCompatible,
  loadQualityPreference,
  saveQualityPreference,
  selectAutoQuality,
  selectHigherResolutionQuality,
  selectLowDataQuality,
  selectManualQuality,
  shouldSwitchFileQuality,
  type QualityPreference,
} from "./qualityPreference";

/** How often Auto re-examines conditions while playback continues. */
const QUALITY_REVIEW_INTERVAL_MS = 15_000;
/** Longest wait for the next quality to buffer before switching regardless. */
const QUALITY_PRELOAD_BUDGET_MS = 20_000;
/**
 * How long a held frame may stay up. A source that never starts playing must
 * not leave a frozen picture on screen with no way out.
 */
const FRAME_HOLD_CEILING_MS = 8_000;
/** Buffered seconds ahead of the playhead that count as comfortable headroom. */
const HEALTHY_BUFFER_SECONDS = 12;

/**
 * Development record of a rendition handoff.
 *
 * The diagnostics shape carries quality ids, heights and timings only, so there
 * is no URL, signed token, cookie or filesystem path to redact before it is
 * printed. Silent in production builds.
 */
function logQualitySwitchDiagnostics(diagnostics: SwitchDiagnostics): void {
  if (!import.meta.env.DEV) return;

  console.info("[Seyirlik Playback] Rendition handoff", diagnostics);
}

/** Seconds of media buffered ahead of the playhead, 0 when nothing is ready. */
function bufferedSecondsAhead(video: HTMLVideoElement | null): number {
  if (!video) return 0;
  const { buffered, currentTime } = video;
  for (let index = buffered.length - 1; index >= 0; index -= 1) {
    if (
      buffered.start(index) <= currentTime &&
      buffered.end(index) > currentTime
    ) {
      return buffered.end(index) - currentTime;
    }
  }
  return 0;
}

function measuredPlayerHeight(
  container: HTMLElement | null,
  video: HTMLVideoElement | null,
): number {
  const measured = container?.clientHeight || video?.clientHeight || 0;
  if (measured > 0) return measured;
  // Before first layout both are 0, and `?? ` does not catch that. Falling
  // through to 1px made Auto target the smallest rendition on every cold start.
  return typeof window === "undefined"
    ? 720
    : Math.round(window.innerHeight * 0.8);
}

function getFileQualitySelectionContext(
  playerHeight: number,
  recentStallCount = 0,
) {
  const connection =
    typeof navigator === "undefined"
      ? undefined
      : (
          navigator as Navigator & {
            connection?: {
              saveData?: boolean;
              effectiveType?: string;
              downlink?: number;
            };
          }
        ).connection;
  return {
    playerHeight: Math.max(1, playerHeight),
    devicePixelRatio:
      typeof window === "undefined" ? 1 : window.devicePixelRatio,
    saveData: connection?.saveData,
    effectiveType: connection?.effectiveType,
    downlinkMbps: connection?.downlink,
    recentStallCount,
  };
}

function isHlsStartupSuccessEvent(eventName: string): boolean {
  const normalizedEventName = eventName.toLowerCase();

  return (
    normalizedEventName.includes("fragbuffered") ||
    normalizedEventName.includes("frag_buffered") ||
    normalizedEventName.includes("bufferappended") ||
    normalizedEventName.includes("buffer_appended")
  );
}

function getSerializableHlsError(data: unknown) {
  if (!data || typeof data !== "object") {
    return data;
  }

  const errorData = data as {
    type?: unknown;
    details?: unknown;
    fatal?: unknown;
    reason?: unknown;
    response?: unknown;
    error?: unknown;
  };

  return {
    type: errorData.type,
    details: errorData.details,
    fatal: errorData.fatal,
    reason: errorData.reason,
    response: errorData.response,
    error:
      errorData.error instanceof Error
        ? {
            name: errorData.error.name,
            message: errorData.error.message,
          }
        : errorData.error
          ? String(errorData.error)
          : undefined,
  };
}

export function CustomVideoPlayer({
  item,
  source,
  playbackCandidates = [],
  notice,
  error,
  hasTranscodingFallback,
  initialStartSeconds = 0,
  onVideoFailure,
  onVideoRecovery,
  onTryTranscodedPlayback,
  onRetryPlayback,
  onPlaybackStarted,
  onPlaybackProgress,
  onPlaybackStopped,
  onPlaybackBeforeUnload,
  onPreparingPlaybackChange,
  nextEpisode = null,
  playbackQueue = null,
  enableDefaultNextEpisodeCountdown = false,
  onAutoPlayNextEpisode,
  onPlayQueueItem,
  preparingBackdropUrl,
  showPreparingArtwork = false,
  backTo,
}: CustomVideoPlayerProps) {
  const { language, t } = useLanguage();
  const viewport = useViewportCapabilities();
  const shouldReduceMotion = Boolean(useReducedMotion());
  const containerRef = useRef<HTMLDivElement | null>(null);
  /**
   * Assigned below, once `buildQualityFileSource` exists. The deck controller
   * calls through this ref so promotion can commit a source that is defined
   * much further down the component than the controller has to be.
   */
  const handleDeckPromotedRef = useRef<
    (commit: { toQualityId: string; url: string; deckId: DeckId }) => void
  >(() => {});
  const activeDeckElementRef = useRef<() => HTMLVideoElement | null>(
    () => null,
  );
  const handleDeckRolledBackRef = useRef<
    (info: { restoredQualityId: string | null; deckId: DeckId }) => void
  >(() => {});
  const deck = useSeamlessQualitySwitch({
    onPromoted: (commit) => handleDeckPromotedRef.current(commit),
    onRolledBack: (info) => handleDeckRolledBackRef.current(info),
    /**
     * Read from the element rather than from React state: at the instant of a
     * handoff, state may still be a render behind what the viewer has just
     * done with the volume slider or the space bar.
     */
    readIntent: (): PlaybackIntent => {
      const video = activeDeckElementRef.current();
      return {
        volume: video?.volume ?? 1,
        muted: video?.muted ?? false,
        playbackRate: video?.playbackRate ?? 1,
        wantsToPlay: video ? !video.paused && !video.ended : false,
      };
    },
    onDiagnostics: logQualitySwitchDiagnostics,
  });
  /**
   * The one way to reach the logical active video element.
   *
   * Every `videoRef.current` in this file resolves through the deck controller,
   * so a read after a promotion returns the element that is now playing rather
   * than the one that was active when the caller was created.
   */
  const videoRef = deck.videoRef;
  const deckEpoch = deck.deckEpoch;
  activeDeckElementRef.current = () => videoRef.current;
  /**
   * Pulled out individually because `deck` itself is a fresh object on every
   * render, and effects here depend on these.
   *
   * Depending on `deck` made the source-attach effect tear the element down and
   * re-attach it on every single render — and since that effect calls
   * `setActiveSource`, it re-triggered itself forever. The video was reloaded
   * continuously and never reached metadata. Each of these is a stable
   * `useCallback` from the controller, so depending on them is honest.
   */
  const {
    deckRefs,
    getDeckElement,
    isActiveDeckElement,
    isRetainedDeckElement,
    isBackedOff: isQualityBackedOff,
    requestSwitch: requestDeckSwitch,
    cancelSwitch: cancelDeckSwitch,
    notifyActiveSeek,
  } = deck;
  const activeAttachmentRef = useRef<AttachedVideoSource | null>(null);
  /**
   * Set during a promotion so the source-attach effect recognises that the deck
   * already holds these bytes. Without it the effect would re-attach the URL to
   * the element that just prepared it and undo the whole handoff.
   */
  const seamlessAdoptionRef = useRef<{
    sourceId: string;
    url: string;
    deckId: DeckId;
  } | null>(null);
  const playbackAttemptIdRef = useRef(0);
  const playbackAttemptRef = useRef<PlaybackAttemptState | null>(null);
  const touchSeekSessionRef = useRef<TouchSeekSessionState>({
    lastTapTime: 0,
    lastTapSide: null,
    isActive: false,
    accumulatedSeconds: 0,
    timeoutId: null,
  });
  const lastProgressReportRef = useRef(0);
  const latestPlaybackPositionRef = useRef(0);
  const hasStartedRef = useRef(false);
  const hasReportedStoppedRef = useRef(false);
  const hasAutoPlayedNextRef = useRef(false);
  const hasAppliedInitialStartRef = useRef(false);
  const sourceSwitchTokenRef = useRef(0);
  const pendingSourceRestoreRef = useRef<PendingSourceRestore | null>(null);
  const pendingAudioTranscodePlayRef = useRef<PendingAudioTranscodePlay | null>(
    null,
  );
  const audioTranscodeReadinessTimerRef = useRef<number | null>(null);
  const subtitleOverlayRef = useRef<HTMLDivElement | null>(null);
  const subtitleDragStateRef = useRef<SubtitleDragState | null>(null);
  const subtitleResizeStateRef = useRef<SubtitleResizeState | null>(null);
  const suppressPlayerTapUntilRef = useRef(0);
  const suppressMouseMoveUntilRef = useRef(0);
  const singleTapTimerRef = useRef<number | null>(null);
  const fullscreenSeekPreviewTokenRef = useRef(0);
  const pendingFullscreenSeekPreviewRef = useRef<{
    token: number;
    targetSeconds: number;
  } | null>(null);
  const fullscreenSeekPreviewFallbackTimerRef = useRef<number | null>(null);
  const viewModeCursorHideTimerRef = useRef<number | null>(null);
  const clearSingleTapTimer = useCallback(() => {
    if (singleTapTimerRef.current !== null) {
      window.clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
    }
  }, []);
  const clearTouchSeekSessionTimeout = useCallback(() => {
    if (touchSeekSessionRef.current.timeoutId !== null) {
      window.clearTimeout(touchSeekSessionRef.current.timeoutId);
      touchSeekSessionRef.current.timeoutId = null;
    }
  }, []);
  const resetTouchSeekSession = useCallback(
    (clearPendingSingleTap = true) => {
      if (clearPendingSingleTap) {
        clearSingleTapTimer();
      }

      clearTouchSeekSessionTimeout();

      touchSeekSessionRef.current.lastTapTime = 0;
      touchSeekSessionRef.current.lastTapSide = null;
      touchSeekSessionRef.current.isActive = false;
      touchSeekSessionRef.current.accumulatedSeconds = 0;
    },
    [clearSingleTapTimer, clearTouchSeekSessionTimeout],
  );
  const mediaFormatLabels = useMemo(
    () => ({
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    [t],
  );
  const itemMetadata = getItemDisplayMetadata(item, language);
  const title =
    item.Type === "Episode"
      ? getDisplayTitle(item, mediaFormatLabels)
      : (itemMetadata.title ?? getDisplayTitle(item, mediaFormatLabels));

  const [isPlaybackInfoOpen, setIsPlaybackInfoOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isPartyWatchOpen, setIsPartyWatchOpen] = useState(false);
  const [isSubtitleEditMode, setIsSubtitleEditMode] = useState(false);
  const [areControlsManuallyHidden, setAreControlsManuallyHidden] =
    useState(false);
  const [isViewModeEnabled, setIsViewModeEnabled] = useState(false);
  const [isViewModeCursorVisible, setIsViewModeCursorVisible] = useState(true);
  const [checkpointSeconds, setCheckpointSeconds] = useState<number | null>(
    null,
  );
  const [hasKnownVideoDuration, setHasKnownVideoDuration] = useState(false);

  const progress = usePlayerProgress(videoRef, deckEpoch);
  const refreshProgress = progress.refresh;

  const hasValidVideoDuration =
    Number.isFinite(progress.duration) && progress.duration > 0;

  const isTimelinePreparing =
    !error &&
    !hasKnownVideoDuration &&
    progress.currentTime <= 0 &&
    !hasValidVideoDuration;

  useEffect(() => {
    if (hasValidVideoDuration) {
      setHasKnownVideoDuration(true);
    }
  }, [hasValidVideoDuration]);

  useEffect(() => {
    onPreparingPlaybackChange?.(isTimelinePreparing);
  }, [isTimelinePreparing, onPreparingPlaybackChange]);

  useEffect(() => {
    return () => {
      onPreparingPlaybackChange?.(false);
    };
  }, [onPreparingPlaybackChange]);

  const { segments: mediaSegments, activeSegment } = useMediaSegments(
    item.Id,
    progress.currentTime,
  );

  const controlsShouldStayVisible =
    isSettingsOpen || isQueueOpen || isPlaybackInfoOpen || isPartyWatchOpen;

  const {
    areControlsVisible,
    showControls,
    keepControlsVisible,
    releaseControlsHover,
  } = useAutoHideControls({
    isPlaying: progress.isPlaying,
    disabled: Boolean(error) || controlsShouldStayVisible,
    playStartDelayMs: 900,
    interactionDelayMs: 2400,
  });

  const shouldShowPlayerChrome =
    !isSubtitleEditMode &&
    !areControlsManuallyHidden &&
    (areControlsVisible || !progress.isPlaying || controlsShouldStayVisible);
  const shouldRenderPlayerChrome = shouldShowPlayerChrome && !isViewModeEnabled;
  const shouldShowPlayerCursor =
    isSubtitleEditMode ||
    shouldRenderPlayerChrome ||
    (isViewModeEnabled && isViewModeCursorVisible);

  const hidePlayerChrome = useCallback(() => {
    setAreControlsManuallyHidden(true);
  }, []);
  const {
    clearSeekFeedbackChromeHideTimer,
    clearSeekFeedbackSpinTimers,
    clearSeekFeedbackTimers,
    hidePlayerChromeWithSeekFeedback,
    seekFeedback,
    triggerSeekFeedback,
  } = useSeekFeedback({
    isPlaying: progress.isPlaying,
    controlsShouldStayVisible,
    onHidePlayerChrome: hidePlayerChrome,
  });

  const revealPlayerChrome = useCallback(() => {
    clearSeekFeedbackChromeHideTimer();
    setAreControlsManuallyHidden(false);
    showControls();
  }, [clearSeekFeedbackChromeHideTimer, showControls]);

  const clearViewModeCursorHideTimer = useCallback(() => {
    if (viewModeCursorHideTimerRef.current !== null) {
      window.clearTimeout(viewModeCursorHideTimerRef.current);
      viewModeCursorHideTimerRef.current = null;
    }
  }, []);

  const revealViewModeCursor = useCallback(() => {
    clearViewModeCursorHideTimer();
    setIsViewModeCursorVisible(true);

    viewModeCursorHideTimerRef.current = window.setTimeout(() => {
      setIsViewModeCursorVisible(false);
      viewModeCursorHideTimerRef.current = null;
    }, VIEW_MODE_CURSOR_HIDE_MS);
  }, [clearViewModeCursorHideTimer]);

  const partyWatch = usePartyWatchController({
    videoRef,
    itemId: item.Id,
    title,
    currentTime: progress.currentTime,
    isPlaying: progress.isPlaying,
    refreshProgress,
    showControls: revealPlayerChrome,
  });
  const partyWatchMemberCount = partyWatch.isInGroup
    ? Math.max(
        1,
        partyWatch.participantCount ?? partyWatch.participantNames?.length ?? 0,
      )
    : 0;
  const visiblePartyWatchDotCount = partyWatch.isInGroup
    ? Math.min(partyWatchMemberCount, PARTY_WATCH_DOT_POSITIONS.length)
    : 1;
  const checkpointButtonLabel =
    checkpointSeconds === null
      ? t("player.setCheckpoint")
      : t("player.returnToCheckpoint");

  const enterViewMode = useCallback(() => {
    setIsViewModeEnabled(true);
    setIsSettingsOpen(false);
    setIsQueueOpen(false);
    setIsPlaybackInfoOpen(false);
    setIsPartyWatchOpen(false);
    setIsSubtitleEditMode(false);
    setAreControlsManuallyHidden(true);
    releaseControlsHover();
    revealViewModeCursor();
  }, [releaseControlsHover, revealViewModeCursor]);

  const exitViewMode = useCallback(() => {
    clearViewModeCursorHideTimer();
    setIsViewModeCursorVisible(true);
    setIsViewModeEnabled(false);
    revealPlayerChrome();
  }, [clearViewModeCursorHideTimer, revealPlayerChrome]);

  const toggleCheckpointMode = useCallback(() => {
    if (checkpointSeconds === null) {
      const video = videoRef.current;
      const currentSeconds =
        video && Number.isFinite(video.currentTime)
          ? video.currentTime
          : progress.currentTime;

      setCheckpointSeconds(Math.max(0, currentSeconds));

      if (!isViewModeEnabled) {
        revealPlayerChrome();
      }

      return;
    }

    const duration =
      Number.isFinite(progress.duration) && progress.duration > 0
        ? progress.duration
        : undefined;
    const target =
      duration !== undefined
        ? clamp(checkpointSeconds, 0, Math.max(0, duration - 0.25))
        : Math.max(0, checkpointSeconds);

    partyWatch.seekTo(target);
    setCheckpointSeconds(null);

    if (!isViewModeEnabled) {
      revealPlayerChrome();
    }
  }, [
    checkpointSeconds,
    isViewModeEnabled,
    partyWatch,
    progress.currentTime,
    progress.duration,
    revealPlayerChrome,
  ]);

  const [displayedPartyEventMessage, setDisplayedPartyEventMessage] = useState<
    string | null
  >(null);
  const [isPartyEventToastLeaving, setIsPartyEventToastLeaving] =
    useState(false);
  const [fullscreenSeekPreviewSeconds, setFullscreenSeekPreviewSeconds] =
    useState<number | null>(null);
  const [dismissedSkipSegmentId, setDismissedSkipSegmentId] = useState<
    string | null
  >(null);
  const [
    dismissedDefaultNextEpisodeItemId,
    setDismissedDefaultNextEpisodeItemId,
  ] = useState<string | null>(null);

  const updateLatestPlaybackPosition = useCallback(() => {
    const currentTime =
      videoRef.current?.currentTime ?? latestPlaybackPositionRef.current;

    if (Number.isFinite(currentTime)) {
      latestPlaybackPositionRef.current = currentTime;
    }

    return latestPlaybackPositionRef.current;
  }, []);

  const reportStoppedOnce = useCallback(
    (useUnloadSafeReport = false) => {
      const positionSeconds = updateLatestPlaybackPosition();

      if (!hasStartedRef.current || hasReportedStoppedRef.current) {
        return;
      }

      hasReportedStoppedRef.current = true;

      if (useUnloadSafeReport) {
        onPlaybackBeforeUnload?.(positionSeconds);
        return;
      }

      onPlaybackStopped?.(positionSeconds);
    },
    [onPlaybackBeforeUnload, onPlaybackStopped, updateLatestPlaybackPosition],
  );

  const reportPlaybackProgressCheckpoint = useCallback(
    (isPaused: boolean, force = false) => {
      if (!hasStartedRef.current) {
        return;
      }

      const positionSeconds = updateLatestPlaybackPosition();
      const now = Date.now();

      if (
        !force &&
        now - lastProgressReportRef.current <
          PLAYBACK_PROGRESS_REPORT_INTERVAL_MS
      ) {
        return;
      }

      lastProgressReportRef.current = now;
      onPlaybackProgress?.(positionSeconds, isPaused);
    },
    [onPlaybackProgress, updateLatestPlaybackPosition],
  );

  const clearAudioTranscodeReadinessTimer = useCallback(() => {
    if (audioTranscodeReadinessTimerRef.current !== null) {
      window.clearTimeout(audioTranscodeReadinessTimerRef.current);
      audioTranscodeReadinessTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (
      dismissedSkipSegmentId &&
      activeSegment?.id !== dismissedSkipSegmentId
    ) {
      setDismissedSkipSegmentId(null);
    }
  }, [activeSegment?.id, dismissedSkipSegmentId]);

  useEffect(() => {
    if (partyWatch.partyEventMessage) {
      setDisplayedPartyEventMessage(partyWatch.partyEventMessage);
      setIsPartyEventToastLeaving(false);
      return undefined;
    }

    if (!displayedPartyEventMessage) {
      return undefined;
    }

    setIsPartyEventToastLeaving(true);

    const timer = window.setTimeout(() => {
      setDisplayedPartyEventMessage(null);
      setIsPartyEventToastLeaving(false);
    }, 260);

    return () => {
      window.clearTimeout(timer);
    };
  }, [partyWatch.partyEventMessage, displayedPartyEventMessage]);

  const [activeSource, setActiveSource] =
    useState<PlaybackSourceCandidate>(source);
  const qualityUserId = getCachedSession()?.userId ?? "anonymous";
  const qualityPreferenceRef = useRef<QualityPreference>(
    loadQualityPreference(qualityUserId),
  );
  const [activeQualityFileId, setActiveQualityFileId] = useState<string | null>(
    null,
  );
  const [fileQualityMode, setFileQualityMode] = useState<QualityPreferenceMode>(
    () => qualityPreferenceRef.current.mode,
  );
  const lastQualitySwitchAtRef = useRef(0);
  const reconsiderQualityRef = useRef<(recentStallCount: number) => void>(
    () => {},
  );
  const applyQualityFileRef = useRef<
    (
      file: AvailableQualityFile,
      preference: QualityPreference,
      options?: { isManual?: boolean },
    ) => Promise<void>
  >(async () => {});
  const preloadVideoRef = useRef<HTMLVideoElement | null>(null);
  /**
   * The last frame of the outgoing quality, painted over the element while it
   * reloads.
   *
   * Assigning a new `src` tears the element down to black, and there is no way
   * to hand buffered media from one element to another. Holding the frame the
   * viewer was already looking at is what makes the change read as a change of
   * quality rather than an interruption.
   */
  const frameHoldCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isHoldingFrame, setIsHoldingFrame] = useState(false);
  const preloadTokenRef = useRef(0);
  const [_isPreparingQuality, setIsPreparingQuality] = useState(false);
  const recentQualityStallsRef = useRef<number[]>([]);
  const [loadedVideoAspectRatio, setLoadedVideoAspectRatio] = useState<
    number | null
  >(null);
  const sourceVideoAspectRatio =
    getVideoAspectRatioFromSource(activeSource) ?? DEFAULT_VIDEO_ASPECT_RATIO;
  const previewAspectRatio = loadedVideoAspectRatio ?? sourceVideoAspectRatio;
  const [selectedQualityId, setSelectedQualityId] = useState(AUTO_QUALITY_ID);
  const [selectedAudioStreamIndex, setSelectedAudioStreamIndex] = useState<
    number | undefined
  >(() => getDefaultAudioStreamIndex(item, source));
  const [activeAudioStreamIndex, setActiveAudioStreamIndex] = useState<
    number | undefined
  >(() =>
    shouldForceDefaultAudioInPlaybackUrl(source)
      ? getDefaultAudioStreamIndex(item, source)
      : getStreamsOfType(source, "Audio").length <= 1
        ? getDefaultAudioStreamIndex(item, source)
        : undefined,
  );
  const [selectedSubtitleStreamIndex, setSelectedSubtitleStreamIndex] =
    useState<number>(() => getDefaultSubtitleStreamIndex(item, source));
  const [lastVideoError, setLastVideoError] = useState<string | null>(null);
  const [qualitySelectionNotice, setQualitySelectionNotice] = useState<
    string | null
  >(null);
  const [isWaitingForAudioTranscodeReady, setIsWaitingForAudioTranscodeReady] =
    useState(false);
  const [liveTranscodingReasons, setLiveTranscodingReasons] = useState<
    string[]
  >([]);
  const [activeSubtitleText, setActiveSubtitleText] = useState("");
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [subtitleDelaySeconds, setSubtitleDelaySeconds] = useState(0);
  const [subtitlePosition, setSubtitlePosition] =
    useState<SubtitlePosition | null>(null);
  const [subtitleSize, setSubtitleSize] = useState<SubtitleSize>({
    scale: DEFAULT_SUBTITLE_SCALE,
  });
  const [isDraggingSubtitle, setIsDraggingSubtitle] = useState(false);
  const [isResizingSubtitle, setIsResizingSubtitle] = useState(false);
  const availablePlaybackCandidates =
    playbackCandidates.length > 0 ? playbackCandidates : [source];
  const qualityManifest =
    activeSource.qualityManifest ?? source.qualityManifest;
  const availableQualityFiles = useMemo(
    () =>
      [...(qualityManifest?.qualities ?? [])].sort(
        (left, right) => right.height - left.height,
      ),
    [qualityManifest],
  );
  const hasFileQualities = availableQualityFiles.length > 0;
  const activeQualityFile = availableQualityFiles.find(
    (quality) => quality.id === activeQualityFileId,
  );
  const audioCompatibleQualityFiles = useMemo(
    () =>
      availableQualityFiles.filter((quality) =>
        isQualityAudioCompatible(quality, selectedAudioStreamIndex),
      ),
    [availableQualityFiles, selectedAudioStreamIndex],
  );
  const lowDataQualityFile = useMemo(
    () => selectLowDataQuality(audioCompatibleQualityFiles),
    [audioCompatibleQualityFiles],
  );
  const higherResolutionQualityFile = useMemo(
    () => selectHigherResolutionQuality(audioCompatibleQualityFiles),
    [audioCompatibleQualityFiles],
  );
  const qualityOptions = useMemo(
    () => getManualQualityOptions(activeSource.mediaSource),
    [activeSource.mediaSource],
  );
  const advancedQualityOptions = useMemo<PlaybackQualityOption[]>(
    () =>
      availableQualityFiles.map((quality) => ({
        id: quality.id,
        label: `${
          quality.kind === "original"
            ? formatTemplate(t("player.qualityOriginalWithHeight"), {
                height: quality.height,
              })
            : `${quality.height}p`
        }${quality.hdr ? " HDR" : ""}`,
        // Only carry a subtitle when it says something the label does not; the
        // check mark already marks the active entry.
        subtitle: isQualityAudioCompatible(quality, selectedAudioStreamIndex)
          ? ""
          : t("player.qualityAudioMismatch"),
        maxHeight: quality.height,
        maxWidth: quality.width,
        maxStreamingBitrate: quality.bitrate ?? Number.MAX_SAFE_INTEGER,
      })),
    [availableQualityFiles, selectedAudioStreamIndex, t],
  );
  /**
   * The original is served by whichever plan the backend already produced, so it
   * is returned untouched: rewriting it into a synthetic direct-play candidate
   * would drop the session id, transcode capability flags and audio-switching
   * fallbacks that original playback still depends on. Only generated complete
   * files become new candidates.
   */
  const buildQualityFileSource = useCallback(
    (quality: AvailableQualityFile): PlaybackSourceCandidate =>
      quality.kind === "original"
        ? source
        : {
            ...source,
            id: `quality-file-${quality.id}`,
            playSessionId: undefined,
            mode: "DirectPlay",
            url: quality.playbackUrl,
            mimeType: quality.container === "mp4" ? "video/mp4" : undefined,
            isHls: false,
            hlsKind: undefined,
            label: quality.label,
            qualityManifest,
            reason: "Validated pre-generated complete rendition file.",
            transcodeReasons: [],
            mediaSource: {
              ...source.mediaSource,
              Container: quality.container ?? source.mediaSource.Container,
              SupportsDirectPlay: true,
              SupportsDirectStream: false,
              SupportsTranscoding: false,
            },
          },
    [qualityManifest, source],
  );
  const persistQualityPreference = useCallback(
    (preference: QualityPreference) => {
      qualityPreferenceRef.current = preference;
      saveQualityPreference(preference, qualityUserId);
    },
    [qualityUserId],
  );
  /**
   * Track list for the pickers. The custom playback backend probes the container
   * with ffprobe, which cannot see sidecar subtitle files (`Film.tr.srt`) and
   * numbers streams differently from the library. The library's own list carries
   * external subtitles and uses the indices its subtitle endpoint expects, so it
   * wins whenever it is available; generated renditions inherit it because they
   * keep the same `mediaSourceId`.
   */
  const libraryMediaStreams = useMemo(() => {
    const librarySource =
      item.MediaSources?.find(
        (candidate) => candidate.Id === activeSource.mediaSourceId,
      ) ?? item.MediaSources?.[0];
    return librarySource?.MediaStreams;
  }, [item, activeSource.mediaSourceId]);

  const activeSourceWithLibraryStreams = useMemo<PlaybackSourceCandidate>(
    () =>
      libraryMediaStreams && libraryMediaStreams.length > 0
        ? {
            ...activeSource,
            mediaSource: {
              ...activeSource.mediaSource,
              MediaStreams: libraryMediaStreams,
            },
          }
        : activeSource,
    [activeSource, libraryMediaStreams],
  );

  const audioStreams = useMemo(
    () => getStreamsOfType(activeSourceWithLibraryStreams, "Audio"),
    [activeSourceWithLibraryStreams],
  );
  const canSwitchAudio = Boolean(
    audioStreams.some((stream) => stream.Index !== undefined) &&
    !activeSource.id.startsWith("quality-file-generated-") &&
    (isDirectBrowserPlaybackSource(activeSource) ||
      activeSource.mediaSource.SupportsTranscoding ||
      activeSource.mode === "Transcoding"),
  );
  const canSwitchSubtitles = Boolean(activeSource.mediaSourceId);
  const sourceDefaultAudioStreamIndex = getDefaultAudioStreamIndex(
    item,
    source,
  );
  const sourceDefaultSubtitleStreamIndex = getDefaultSubtitleStreamIndex(
    item,
    source,
  );
  const activeSourceDefaultAudioStreamIndex = getDefaultAudioStreamIndex(
    item,
    activeSource,
  );
  const selectedAudioIndexForActiveSource =
    selectedAudioStreamIndex ?? activeSourceDefaultAudioStreamIndex;

  const initializeSubtitleEditPosition = useCallback(() => {
    const bounds = containerRef.current?.getBoundingClientRect();
    const overlayBounds = subtitleOverlayRef.current?.getBoundingClientRect();

    if (!bounds || !overlayBounds) {
      return;
    }

    const overlayCenterX = overlayBounds.left + overlayBounds.width / 2;
    const overlayCenterY = overlayBounds.top + overlayBounds.height / 2;

    setSubtitlePosition(
      (currentPosition) =>
        currentPosition ?? {
          x: clamp(
            ((overlayCenterX - bounds.left) / bounds.width) * 100,
            8,
            92,
          ),
          y: clamp(
            ((overlayCenterY - bounds.top) / bounds.height) * 100,
            10,
            90,
          ),
        },
    );
  }, []);

  const startSubtitleEditMode = useCallback(() => {
    initializeSubtitleEditPosition();
    setIsSettingsOpen(false);
    setIsQueueOpen(false);
    setIsPlaybackInfoOpen(false);
    setIsPartyWatchOpen(false);
    setIsDraggingSubtitle(false);
    setIsResizingSubtitle(false);
    setIsSubtitleEditMode(true);
    setAreControlsManuallyHidden(true);
    subtitleDragStateRef.current = null;
    subtitleResizeStateRef.current = null;
    suppressPlayerTapUntilRef.current = Date.now() + 350;
    resetTouchSeekSession();
    releaseControlsHover();
  }, [
    initializeSubtitleEditPosition,
    releaseControlsHover,
    resetTouchSeekSession,
  ]);

  const finishSubtitleEditMode = useCallback(() => {
    setIsSubtitleEditMode(false);
    setIsDraggingSubtitle(false);
    setIsResizingSubtitle(false);
    subtitleDragStateRef.current = null;
    subtitleResizeStateRef.current = null;
    suppressPlayerTapUntilRef.current = Date.now() + 350;
    resetTouchSeekSession();
    revealPlayerChrome();
  }, [resetTouchSeekSession, revealPlayerChrome]);

  const sourceWithLiveTranscodingReasons =
    useMemo<PlaybackSourceCandidate>(() => {
      if (liveTranscodingReasons.length === 0) {
        return activeSourceWithLibraryStreams;
      }

      const mergedTranscodeReasons = Array.from(
        new Set(
          [
            ...(activeSource.transcodeReasons ?? []),
            ...(activeSource.mediaSource.TranscodingReasons ?? []),
            ...liveTranscodingReasons,
          ].filter(Boolean),
        ),
      );

      return {
        ...activeSourceWithLibraryStreams,
        transcodeReasons: mergedTranscodeReasons,
        mediaSource: {
          ...activeSourceWithLibraryStreams.mediaSource,
          TranscodingReasons: mergedTranscodeReasons,
        },
      };
    }, [activeSourceWithLibraryStreams, liveTranscodingReasons]);

  useCustomPlaybackSessionLease(activeSource);

  const skippableActiveSegment = useMemo(() => {
    if (
      Boolean(error) ||
      isSettingsOpen ||
      isQueueOpen ||
      isPlaybackInfoOpen ||
      isPartyWatchOpen ||
      isSubtitleEditMode ||
      (partyWatch.isInGroup && !partyWatch.canControl) ||
      !Number.isFinite(progress.currentTime)
    ) {
      return null;
    }

    return (
      mediaSegments.find(
        (segment) =>
          segment.id !== dismissedSkipSegmentId &&
          isSkippableSegmentType(segment.type) &&
          progress.currentTime >= segment.startSeconds &&
          progress.currentTime < segment.endSeconds &&
          segment.endSeconds - progress.currentTime > 1,
      ) ?? null
    );
  }, [
    dismissedSkipSegmentId,
    error,
    isPartyWatchOpen,
    isPlaybackInfoOpen,
    isQueueOpen,
    isSettingsOpen,
    isSubtitleEditMode,
    mediaSegments,
    partyWatch.canControl,
    partyWatch.isInGroup,
    progress.currentTime,
  ]);

  const skipSegmentLabel = skippableActiveSegment
    ? t(getSkipSegmentLabelKey(skippableActiveSegment.type))
    : t("player.skipSegment");

  const hasDataDrivenNextUp = useMemo(
    () =>
      mediaSegments.some((segment) => isNextEpisodeSegmentType(segment.type)),
    [mediaSegments],
  );
  const defaultNextEpisodeRemainingSeconds =
    Number.isFinite(progress.duration) && progress.duration > 0
      ? progress.duration - progress.currentTime
      : Number.POSITIVE_INFINITY;
  const defaultNextEpisodeCountdownSeconds =
    Number.isFinite(defaultNextEpisodeRemainingSeconds) &&
    defaultNextEpisodeRemainingSeconds > 0 &&
    defaultNextEpisodeRemainingSeconds <= DEFAULT_NEXT_EPISODE_COUNTDOWN_SECONDS
      ? clamp(
          Math.ceil(defaultNextEpisodeRemainingSeconds),
          1,
          DEFAULT_NEXT_EPISODE_COUNTDOWN_SECONDS,
        )
      : null;
  const isDefaultNextEpisodeDismissed =
    dismissedDefaultNextEpisodeItemId === item.Id;
  const isDefaultNextEpisodeCountdownEnabled = Boolean(
    enableDefaultNextEpisodeCountdown &&
    nextEpisode &&
    onAutoPlayNextEpisode &&
    !partyWatch.isInGroup &&
    !error &&
    Number.isFinite(progress.duration) &&
    progress.duration > 0,
  );
  const shouldShowDefaultNextEpisodeCountdown = Boolean(
    isDefaultNextEpisodeCountdownEnabled &&
    !isDefaultNextEpisodeDismissed &&
    defaultNextEpisodeCountdownSeconds !== null,
  );
  const handlePlayQueueItem = useCallback(
    (queueItemId: string) => {
      const queueItem = playbackQueue?.items.find(
        (candidate) => candidate.Id === queueItemId,
      );

      if (!queueItem) {
        return;
      }

      setIsQueueOpen(false);
      onPlayQueueItem?.(queueItem);
    },
    [onPlayQueueItem, playbackQueue?.items],
  );

  useEffect(() => {
    if (!playbackQueue) {
      setIsQueueOpen(false);
      return;
    }
  }, [playbackQueue]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      console.info("[Seyirlik Next Episode State Debug]", {
        itemId: item.Id,
        itemName: item.Name,
        itemType: item.Type,
        seriesId: item.SeriesId,
        seasonId: item.SeasonId,
        parentId: item.ParentId,
        indexNumber: item.IndexNumber,
        nextEpisode: nextEpisode
          ? { id: nextEpisode.Id, name: nextEpisode.Name }
          : null,
        progressDuration: progress.duration,
        progressCurrentTime: progress.currentTime,
        remainingSeconds: defaultNextEpisodeRemainingSeconds,
        countdownSeconds: defaultNextEpisodeCountdownSeconds,
        enableDefaultCountdown: enableDefaultNextEpisodeCountdown,
        partyWatchInGroup: partyWatch.isInGroup,
        error,
        hasDataDrivenNextUp,
        shouldShowDefaultNextEpisodeCountdown,
      });
    }
  }, [
    item,
    nextEpisode,
    progress.duration,
    progress.currentTime,
    defaultNextEpisodeRemainingSeconds,
    defaultNextEpisodeCountdownSeconds,
    enableDefaultNextEpisodeCountdown,
    partyWatch.isInGroup,
    error,
    hasDataDrivenNextUp,
    shouldShowDefaultNextEpisodeCountdown,
  ]);

  const fullscreenSeekPreview = useMemo(() => {
    if (
      fullscreenSeekPreviewSeconds === null ||
      !activeSource.mediaSourceId ||
      progress.duration <= 0
    ) {
      return null;
    }

    const globalTileIndex = Math.max(
      0,
      Math.floor(fullscreenSeekPreviewSeconds / TRICKPLAY_INTERVAL_SECONDS),
    );
    const sheetIndex = Math.floor(globalTileIndex / TRICKPLAY_IMAGES_PER_SHEET);
    const tileIndexOnSheet = globalTileIndex % TRICKPLAY_IMAGES_PER_SHEET;
    const column = tileIndexOnSheet % TRICKPLAY_COLUMNS;
    const row = Math.floor(tileIndexOnSheet / TRICKPLAY_COLUMNS);

    return {
      imageUrl: getItemTrickplayImageUrl(activeSource.itemId, sheetIndex),
      column,
      row,
    };
  }, [
    activeSource.itemId,
    activeSource.mediaSourceId,
    fullscreenSeekPreviewSeconds,
    progress.duration,
  ]);

  const fullscreenSeekPreviewRect = useMemo(() => {
    const video = videoRef.current;
    const container = containerRef.current;

    if (!video || !container) {
      return null;
    }

    const containerBounds = container.getBoundingClientRect();
    const videoAspect =
      loadedVideoAspectRatio ??
      getVideoAspectRatioFromElement(video) ??
      sourceVideoAspectRatio;

    const containerAspect = containerBounds.width / containerBounds.height;

    let width = containerBounds.width;
    let height = containerBounds.height;
    let left = 0;
    let top = 0;

    if (containerAspect > videoAspect) {
      height = containerBounds.height;
      width = height * videoAspect;
      left = (containerBounds.width - width) / 2;
    } else {
      width = containerBounds.width;
      height = width / videoAspect;
      top = (containerBounds.height - height) / 2;
    }

    return {
      left,
      top,
      width,
      height,
    };
  }, [
    fullscreenSeekPreviewSeconds,
    loadedVideoAspectRatio,
    progress.duration,
    sourceVideoAspectRatio,
    viewport.height,
    viewport.width,
  ]);

  useEffect(() => {
    setLoadedVideoAspectRatio(null);
    setHasKnownVideoDuration(false);
  }, [activeSource.id, activeSource.url]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    const syncVideoAspectRatio = () => {
      setLoadedVideoAspectRatio(getVideoAspectRatioFromElement(video));
    };

    syncVideoAspectRatio();

    video.addEventListener("loadedmetadata", syncVideoAspectRatio);
    video.addEventListener("loadeddata", syncVideoAspectRatio);
    video.addEventListener("resize", syncVideoAspectRatio);

    return () => {
      video.removeEventListener("loadedmetadata", syncVideoAspectRatio);
      video.removeEventListener("loadeddata", syncVideoAspectRatio);
      video.removeEventListener("resize", syncVideoAspectRatio);
    };
  }, [activeSource.id, activeSource.url, deckEpoch, videoRef]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    const disableTracks = () => {
      disableNativeVideoTextTracks(video);
    };

    disableTracks();

    video.addEventListener("loadedmetadata", disableTracks);
    video.addEventListener("loadeddata", disableTracks);
    video.addEventListener("canplay", disableTracks);
    video.addEventListener("play", disableTracks);

    video.textTracks.addEventListener?.("addtrack", disableTracks);
    video.textTracks.addEventListener?.("change", disableTracks);

    const interval = window.setInterval(disableTracks, 500);

    return () => {
      video.removeEventListener("loadedmetadata", disableTracks);
      video.removeEventListener("loadeddata", disableTracks);
      video.removeEventListener("canplay", disableTracks);
      video.removeEventListener("play", disableTracks);

      video.textTracks.removeEventListener?.("addtrack", disableTracks);
      video.textTracks.removeEventListener?.("change", disableTracks);

      window.clearInterval(interval);
    };
  }, [activeSource.id, activeSource.url, deckEpoch, videoRef]);

  useEffect(() => {
    // Selecting the initial quality now creates a server session, so the
    // work is asynchronous; an effect callback cannot be.
    const applyInitialQuality = async () => {
      const defaultAudioIndex = sourceDefaultAudioStreamIndex;
      const storedPreference = loadQualityPreference(qualityUserId);
      let nextSource = source;
      let manualQualityUnavailable = false;

      if (canInjectDefaultAudioIntoStreamCopy(source, defaultAudioIndex)) {
        try {
          nextSource =
            (await buildConfiguredHlsPlaybackSource(
              source,
              { audioStreamIndex: defaultAudioIndex },
              "Auto HLS",
            )) ?? nextSource;
        } catch (switchError) {
          console.warn(
            "[Seyirlik Playback] Could not force default audio stream for initial playback",
            switchError,
          );
        }
      }

      if (hasFileQualities) {
        const initialQualityFiles = availableQualityFiles.filter((quality) =>
          isQualityAudioCompatible(quality, defaultAudioIndex),
        );
        const playerHeight =
          containerRef.current?.clientHeight ??
          (typeof window === "undefined" ? 720 : window.innerHeight * 0.7);
        const selectedFile =
          storedPreference.mode === "low-data"
            ? selectLowDataQuality(initialQualityFiles)
            : storedPreference.mode === "higher-resolution"
              ? selectHigherResolutionQuality(initialQualityFiles)
              : storedPreference.mode === "advanced"
                ? selectManualQuality(initialQualityFiles, storedPreference)
                : selectAutoQuality(
                    initialQualityFiles,
                    getFileQualitySelectionContext(playerHeight),
                  );
        if (selectedFile) {
          nextSource = buildQualityFileSource(selectedFile);
          setActiveQualityFileId(selectedFile.id);
        } else if (storedPreference.mode === "advanced") {
          manualQualityUnavailable = true;
        }
      }

      playbackAttemptIdRef.current += 1;
      playbackAttemptRef.current = null;
      pendingSourceRestoreRef.current = null;
      // A title change is not a rendition handoff. Anything the deck controller
      // had in flight was prepared against the old timeline and must not be
      // allowed to promote onto the new one.
      cancelDeckSwitch("title-change");
      seamlessAdoptionRef.current = null;
      latestPlaybackPositionRef.current = 0;
      hasReportedStoppedRef.current = false;
      hasAutoPlayedNextRef.current = false;
      qualityPreferenceRef.current = storedPreference;
      setActiveSource(nextSource);
      setFileQualityMode(storedPreference.mode);
      setSelectedQualityId(AUTO_QUALITY_ID);
      setSelectedAudioStreamIndex(defaultAudioIndex);
      setActiveAudioStreamIndex(
        shouldForceDefaultAudioInPlaybackUrl(nextSource) ||
          getStreamsOfType(nextSource, "Audio").length <= 1
          ? defaultAudioIndex
          : undefined,
      );
      setSelectedSubtitleStreamIndex(sourceDefaultSubtitleStreamIndex);
      setQualitySelectionNotice(
        manualQualityUnavailable ? t("player.qualityManualUnavailable") : null,
      );
      setLastVideoError(null);
      setLiveTranscodingReasons([]);
      setCheckpointSeconds(null);
      setIsViewModeCursorVisible(true);
      setIsViewModeEnabled(false);
    };

    void applyInitialQuality();
  }, [
    availableQualityFiles,
    buildQualityFileSource,
    hasFileQualities,
    item.Id,
    qualityUserId,
    source.id,
    source.mediaSourceId,
    source.url,
    sourceDefaultAudioStreamIndex,
    sourceDefaultSubtitleStreamIndex,
    t,
  ]);
  useEffect(() => {
    let isCancelled = false;
    let intervalId: number | null = null;

    const shouldFetchLiveReasons =
      !isCustomPlaybackCandidate(activeSource) &&
      (activeSource.mode === "Transcoding" || activeSource.isHls);

    if (!shouldFetchLiveReasons) {
      setLiveTranscodingReasons([]);
      return undefined;
    }

    const fetchLiveReasons = async () => {
      try {
        const reasons = await getActiveTranscodingReasons(
          activeSource.itemId,
          activeSource.playSessionId,
        );

        if (isCancelled) {
          return;
        }

        setLiveTranscodingReasons((currentReasons) => {
          const nextReasons = Array.from(new Set(reasons.filter(Boolean)));

          if (
            currentReasons.length === nextReasons.length &&
            currentReasons.every(
              (reason, index) => reason === nextReasons[index],
            )
          ) {
            return currentReasons;
          }

          return nextReasons;
        });
      } catch (reasonError) {
        if (!isCancelled) {
          console.warn(
            "[Seyirlik Playback] Could not fetch live transcoding reasons",
            reasonError,
          );
        }
      }
    };

    void fetchLiveReasons();
    intervalId = window.setInterval(fetchLiveReasons, 3500);

    return () => {
      isCancelled = true;

      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [
    activeSource.itemId,
    activeSource.playSessionId,
    activeSource.mode,
    activeSource.isHls,
  ]);

  useEffect(() => {
    if (!isViewModeEnabled) {
      clearViewModeCursorHideTimer();
      setIsViewModeCursorVisible(true);
      return undefined;
    }

    revealViewModeCursor();

    return clearViewModeCursorHideTimer;
  }, [clearViewModeCursorHideTimer, isViewModeEnabled, revealViewModeCursor]);

  useEffect(() => {
    latestPlaybackPositionRef.current = 0;
    hasReportedStoppedRef.current = false;
    hasAutoPlayedNextRef.current = false;
    hasAppliedInitialStartRef.current = false;
    setActiveSubtitleText("");
    setSubtitlePosition(null);
    setSubtitleSize({ scale: DEFAULT_SUBTITLE_SCALE });
    setIsDraggingSubtitle(false);
    setIsResizingSubtitle(false);
    setIsSubtitleEditMode(false);
    setAreControlsManuallyHidden(false);
    setCheckpointSeconds(null);
    setDismissedDefaultNextEpisodeItemId(null);
    setIsViewModeCursorVisible(true);
    setIsViewModeEnabled(false);
    subtitleDragStateRef.current = null;
    subtitleResizeStateRef.current = null;
    suppressPlayerTapUntilRef.current = 0;
    resetTouchSeekSession();
  }, [item.Id, resetTouchSeekSession]);

  useEffect(() => {
    hasAutoPlayedNextRef.current = false;
  }, [activeSource.id, activeSource.url]);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void container.requestFullscreen?.();
    }
  }, []);

  const handleSeekBy = useCallback(
    (seconds: number) => {
      partyWatch.seekBy(seconds);
      triggerSeekFeedback(seconds);
      revealPlayerChrome();
      hidePlayerChromeWithSeekFeedback();
    },
    [
      hidePlayerChromeWithSeekFeedback,
      partyWatch,
      revealPlayerChrome,
      triggerSeekFeedback,
    ],
  );

  const handleSkipSegment = useCallback(
    (segment: NormalizedMediaSegment) => {
      const video = videoRef.current;
      const videoDuration = video?.duration;
      const duration =
        typeof videoDuration === "number" &&
        Number.isFinite(videoDuration) &&
        videoDuration > 0
          ? videoDuration
          : progress.duration;
      const rawTarget = segment.endSeconds + 0.15;
      const target =
        Number.isFinite(duration) && duration > 0
          ? clamp(rawTarget, 0, Math.max(0, duration - 0.25))
          : Math.max(0, rawTarget);

      setDismissedSkipSegmentId(segment.id);
      partyWatch.seekTo(target);
      revealPlayerChrome();
    },
    [partyWatch, progress.duration, revealPlayerChrome],
  );

  const handleDefaultNextEpisodePlay = useCallback(() => {
    if (
      !nextEpisode ||
      !isDefaultNextEpisodeCountdownEnabled ||
      isDefaultNextEpisodeDismissed ||
      hasAutoPlayedNextRef.current
    ) {
      return;
    }

    hasAutoPlayedNextRef.current = true;
    onAutoPlayNextEpisode?.(nextEpisode);
  }, [
    isDefaultNextEpisodeCountdownEnabled,
    isDefaultNextEpisodeDismissed,
    nextEpisode,
    onAutoPlayNextEpisode,
  ]);

  const handleDefaultNextEpisodeCancel = useCallback(() => {
    setDismissedDefaultNextEpisodeItemId(item.Id);
    revealPlayerChrome();
  }, [item.Id, revealPlayerChrome]);

  useKeyboardShortcuts({
    enabled: true,
    onTogglePlay: partyWatch.togglePlay,
    onSeekBy: handleSeekBy,
    onToggleMute: progress.toggleMute,
    onToggleFullscreen: toggleFullscreen,
  });

  useEffect(() => {
    if (!isSettingsOpen) {
      return undefined;
    }

    const handlePointerDownOutside = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement | null;

      if (target?.closest("[data-player-settings-root]")) {
        return;
      }

      setIsSettingsOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDownOutside);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDownOutside);
    };
  }, [isSettingsOpen]);

  useEffect(() => {
    if (!isQueueOpen) {
      return undefined;
    }

    const handlePointerDownOutsideQueue = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement | null;

      if (target?.closest("[data-player-queue-root]")) {
        return;
      }

      setIsQueueOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDownOutsideQueue);

    return () => {
      document.removeEventListener(
        "pointerdown",
        handlePointerDownOutsideQueue,
      );
    };
  }, [isQueueOpen]);

  useEffect(() => {
    if (!isPartyWatchOpen) {
      return undefined;
    }

    const handlePointerDownOutsidePartyWatch = (
      event: globalThis.PointerEvent,
    ) => {
      const target = event.target as HTMLElement | null;

      if (target?.closest("[data-party-watch-root]")) {
        return;
      }

      setIsPartyWatchOpen(false);
    };

    document.addEventListener(
      "pointerdown",
      handlePointerDownOutsidePartyWatch,
    );

    return () => {
      document.removeEventListener(
        "pointerdown",
        handlePointerDownOutsidePartyWatch,
      );
    };
  }, [isPartyWatchOpen]);

  useEffect(() => {
    if (!isSubtitleEditMode) {
      return undefined;
    }

    const handlePointerDownOutsideSubtitle = (
      event: globalThis.PointerEvent,
    ) => {
      const target = event.target as HTMLElement | null;

      if (
        target?.closest("[data-subtitle-editor-root]") ||
        target?.closest("[data-player-settings-root]") ||
        target?.closest("[data-player-queue-root]")
      ) {
        return;
      }

      finishSubtitleEditMode();
    };

    document.addEventListener("pointerdown", handlePointerDownOutsideSubtitle);

    return () => {
      document.removeEventListener(
        "pointerdown",
        handlePointerDownOutsideSubtitle,
      );
    };
  }, [finishSubtitleEditMode, isSubtitleEditMode]);

  const stopCurrentPlaybackForSourceSwitch = useCallback(
    async (currentSource: PlaybackSourceCandidate) => {
      const video = videoRef.current;

      try {
        video?.pause();
      } catch {
        // Ignore pause errors during source switching.
      }

      try {
        activeAttachmentRef.current?.destroy();
      } catch (destroyError) {
        console.warn(
          "[Seyirlik Playback] Could not destroy current video attachment before source switch",
          destroyError,
        );
      } finally {
        activeAttachmentRef.current = null;
      }

      try {
        video?.removeAttribute("src");
        video?.load();
      } catch {
        // Ignore media reset errors during source switching.
      }

      if (isCustomPlaybackCandidate(currentSource)) {
        try {
          await stopCustomPlaybackSessionImmediately(currentSource);
        } catch (stopError) {
          console.warn(
            "[Seyirlik Playback] Could not stop active custom playback session",
            stopError,
          );
        }
        return;
      }

      if (currentSource.mode === "Transcoding" || currentSource.isHls) {
        try {
          await stopActiveTranscodeSession(currentSource.playSessionId);
        } catch (stopError) {
          console.warn(
            "[Seyirlik Playback] Could not stop active transcode session",
            stopError,
          );
        }
      }
    },
    [],
  );

  const switchPlayerSource = useCallback(
    async (
      nextSource: PlaybackSourceCandidate,
      options: { preserveCachedBytes?: boolean } = {},
    ) => {
      const video = videoRef.current;

      if (
        nextSource.id === activeSource.id &&
        nextSource.url === activeSource.url
      ) {
        return;
      }

      sourceSwitchTokenRef.current += 1;
      const switchToken = sourceSwitchTokenRef.current;
      playbackAttemptIdRef.current += 1;
      playbackAttemptRef.current = null;

      const currentTime = video?.currentTime ?? progress.currentTime;
      const wasPlaying = video
        ? !video.paused && !video.ended
        : progress.isPlaying;

      pendingSourceRestoreRef.current = {
        token: switchToken,
        currentTime,
        wasPlaying,
        volume: video?.volume ?? 1,
        muted: video?.muted ?? false,
        playbackRate: video?.playbackRate ?? 1,
        selectedAudioStreamIndex,
        selectedSubtitleStreamIndex,
      };
      pendingAudioTranscodePlayRef.current = null;
      clearAudioTranscodeReadinessTimer();
      setIsWaitingForAudioTranscodeReady(false);

      setLastVideoError(null);
      revealPlayerChrome();

      await stopCurrentPlaybackForSourceSwitch(activeSource);
      if (sourceSwitchTokenRef.current !== switchToken) return;

      // A restart of the *same* URL needs a distinct one, or the element
      // ignores the assignment and nothing reloads. A quality switch is already
      // a different URL, and busting it there would discard the copy the
      // warm-up just pulled into the HTTP cache — turning a prepared switch
      // back into a download from zero.
      const cacheBustedUrl = options.preserveCachedBytes
        ? nextSource.url
        : (() => {
            try {
              const url = new URL(nextSource.url);
              url.searchParams.set(
                "seyirlikRestart",
                `${Date.now()}-${switchToken}`,
              );
              return url.toString();
            } catch {
              return nextSource.url;
            }
          })();

      setActiveSource({
        ...nextSource,
        url: cacheBustedUrl,
      });
    },
    [
      activeSource,
      clearAudioTranscodeReadinessTimer,
      progress.currentTime,
      progress.isPlaying,
      selectedAudioStreamIndex,
      selectedSubtitleStreamIndex,
      revealPlayerChrome,
      stopCurrentPlaybackForSourceSwitch,
    ],
  );

  /**
   * Re-plans the current title under a quality or audio selection.
   *
   * Asynchronous because native playback changes quality by creating a new
   * server session rather than by rewriting a URL. A null result means the
   * server declined the request; callers treat that as "keep what is playing".
   */
  const buildConfiguredSource = useCallback(
    async (
      baseSource: PlaybackSourceCandidate,
      quality?: PlaybackQualityOption,
      audioStreamIndex = selectedAudioStreamIndex,
    ): Promise<PlaybackSourceCandidate> => {
      const settings: PlaybackSourceSettings = {
        ...getQualitySettings(quality),
        audioStreamIndex,
      };

      const configured = await buildConfiguredHlsPlaybackSource(
        baseSource,
        settings,
        quality ? `${quality.label} HLS` : "Auto HLS",
      );

      if (!configured) {
        throw new Error("The server could not prepare that quality.");
      }
      return configured;
    },
    [selectedAudioStreamIndex],
  );

  /**
   * Applies a quality that is already backed by a complete file. Nothing here can
   * start an encode: the file either exists in the validated manifest or it is
   * not offered at all.
   */
  /**
   * Buffers the target file in a detached element at the current position while
   * the existing quality keeps playing, then swaps. Without this the element is
   * torn down first and the viewer stares at a spinner for the whole fetch.
   * Resolves either when enough media is ready or when the budget expires, so a
   * slow link degrades to the old behaviour instead of hanging.
   */
  const warmQualityBeforeSwitch = useCallback(
    (url: string, positionSeconds: number, token: number) => {
      const preload = preloadVideoRef.current;
      if (!preload) return Promise.resolve();

      return warmQualityAtPosition({
        element: preload,
        url,
        positionSeconds,
        budgetMs: QUALITY_PRELOAD_BUDGET_MS,
        isSuperseded: () => preloadTokenRef.current !== token,
        setTimeout: (handler, timeout) => window.setTimeout(handler, timeout),
        clearTimeout: (handle) => window.clearTimeout(handle),
        setInterval: (handler, timeout) => window.setInterval(handler, timeout),
        clearInterval: (handle) => window.clearInterval(handle),
      });
    },
    [],
  );

  /**
   * Paints the current frame onto the hold canvas.
   *
   * Drawing a cross-origin frame taints the canvas, which only forbids reading
   * the pixels back — displaying it is fine, and nothing here reads them.
   */
  const holdCurrentFrame = useCallback((): boolean => {
    const video = videoRef.current;
    const canvas = frameHoldCanvasRef.current;
    if (!video || !canvas) return false;
    if (!video.videoWidth || !video.videoHeight) return false;

    const context = canvas.getContext("2d");
    if (!context) return false;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      return false;
    }

    setIsHoldingFrame(true);
    return true;
  }, []);

  /**
   * Whether this particular change can be handed over between decks.
   *
   * The seamless path is for validated complete files on one timeline. Anything
   * else — a different audio encode, an HLS session, a source whose duration
   * does not match — keeps the controlled replacement path, which is slower to
   * look at but is the only thing that is correct for those cases.
   */
  const canHandOffSeamlessly = useCallback(
    (
      selectedFile: AvailableQualityFile,
      nextSource: PlaybackSourceCandidate,
    ) => {
      const standby = getDeckElement(deck.standbyDeckId);
      const currentQuality = activeQualityFileId;
      const mimeType = nextSource.mimeType ?? "video/mp4";

      return evaluateSeamlessEligibility({
        currentIsCompleteFile:
          currentQuality !== null &&
          !activeSource.isHls &&
          activeSource.mode !== "Transcoding",
        targetIsCompleteFile:
          selectedFile.kind === "generated" ||
          (!nextSource.isHls && nextSource.mode !== "Transcoding"),
        targetIsHls: Boolean(nextSource.isHls),
        targetIsSeekable: nextSource.mode !== "Transcoding",
        sameTimeline:
          nextSource.mediaSourceId === activeSource.mediaSourceId ||
          nextSource.itemId === activeSource.itemId,
        changesAudioEncode: !isQualityAudioCompatible(
          selectedFile,
          selectedAudioStreamIndex,
        ),
        targetCodecPlayable:
          !standby || typeof standby.canPlayType !== "function"
            ? true
            : standby.canPlayType(mimeType) !== "",
        partyWatchSeekInFlight: partyWatch.isApplyingRemoteCommand,
        sameQuality: selectedFile.id === currentQuality,
      });
    },
    [
      activeQualityFileId,
      activeSource.isHls,
      activeSource.itemId,
      activeSource.mediaSourceId,
      activeSource.mode,
      deck.standbyDeckId,
      getDeckElement,
      partyWatch.isApplyingRemoteCommand,
      selectedAudioStreamIndex,
    ],
  );

  /**
   * The controlled-replacement path, kept for the changes that cannot be handed
   * over: it warms the bytes, freezes the outgoing frame, and reloads the
   * element. This is what every rendition change used to do, and what the black
   * frame and the `00:00 / 00:00` clock came from.
   */
  const replaceSourceForQualityFile = useCallback(
    async (nextSource: PlaybackSourceCandidate) => {
      const token = (preloadTokenRef.current += 1);
      setIsPreparingQuality(true);
      try {
        await warmQualityBeforeSwitch(
          nextSource.url,
          videoRef.current?.currentTime ?? progress.currentTime,
          token,
        );
        if (preloadTokenRef.current !== token) return;
        holdCurrentFrame();
        await switchPlayerSource(nextSource, { preserveCachedBytes: true });
      } catch (switchError: unknown) {
        console.warn(
          "[Seyirlik Playback] Complete-file quality switch failed",
          switchError,
        );
        setLastVideoError(t("player.qualitySwitchFailedReturnAuto"));
      } finally {
        if (preloadTokenRef.current === token) setIsPreparingQuality(false);
        const preload = preloadVideoRef.current;
        if (preload) {
          preload.removeAttribute("src");
          preload.load();
        }
      }
    },
    [
      holdCurrentFrame,
      progress.currentTime,
      switchPlayerSource,
      t,
      videoRef,
      warmQualityBeforeSwitch,
    ],
  );

  const applyQualityFile = useCallback(
    async (
      selectedFile: AvailableQualityFile,
      preference: QualityPreference,
      options: { isManual?: boolean } = {},
    ) => {
      setQualitySelectionNotice(null);
      persistQualityPreference(preference);
      setFileQualityMode(preference.mode);
      // The server quality list is not rendered while complete files drive the
      // picker, so its selection stays on Auto.
      setSelectedQualityId(AUTO_QUALITY_ID);

      const nextSource = buildQualityFileSource(selectedFile);

      if (activeSource.id === nextSource.id) {
        setActiveQualityFileId(selectedFile.id);
        return;
      }

      lastQualitySwitchAtRef.current = Date.now();

      const eligibility = canHandOffSeamlessly(selectedFile, nextSource);

      if (!eligibility.eligible) {
        // Nothing seamless is possible here, so the label moves with the
        // reload the way it always did.
        setActiveQualityFileId(selectedFile.id);
        await replaceSourceForQualityFile(nextSource);
        return;
      }

      const isManual = options.isManual ?? preference.mode !== "auto";
      const outcome = await requestDeckSwitch({
        url: nextSource.url,
        toQualityId: selectedFile.id,
        toHeight: selectedFile.height,
        fromQualityId: activeQualityFileId,
        fromHeight: activeQualityFile?.height ?? null,
        isManual,
      });

      if (outcome === "promoted") return;

      // Anything else leaves the current rendition playing untouched. A failed
      // switch must never fall through to the destructive path on its own —
      // that would turn a quality that could not load into a black screen.
      if (outcome === "failed" && isManual) {
        setQualitySelectionNotice(t("player.qualitySwitchFailedReturnAuto"));
      }
    },
    [
      activeQualityFile?.height,
      activeQualityFileId,
      activeSource.id,
      buildQualityFileSource,
      canHandOffSeamlessly,
      persistQualityPreference,
      requestDeckSwitch,
      replaceSourceForQualityFile,
      t,
    ],
  );

  /**
   * Commits the promoted rendition.
   *
   * Called from inside the handoff, which is the only moment the new quality is
   * actually on screen — so it is also the only moment the label, the source
   * and the reporting should agree that it is.
   */
  const handleDeckPromoted = useCallback(
    ({
      toQualityId,
      url,
      deckId,
    }: {
      toQualityId: string;
      url: string;
      deckId: DeckId;
    }) => {
      const promotedFile = availableQualityFiles.find(
        (quality) => quality.id === toQualityId,
      );
      if (!promotedFile) return;

      const promotedSource = buildQualityFileSource(promotedFile);

      // Tells the source-attach effect that this deck already holds these
      // bytes, so it binds listeners without re-attaching anything.
      seamlessAdoptionRef.current = {
        sourceId: promotedSource.id,
        url,
        deckId,
      };
      setActiveQualityFileId(toQualityId);
      setActiveSource({ ...promotedSource, url });
    },
    [availableQualityFiles, buildQualityFileSource],
  );

  /**
   * Puts the committed source back when a promotion is undone.
   *
   * The restored deck still holds the previous quality's bytes and is playing
   * them, so this marks it as adopted: the attach effect then rebinds listeners
   * instead of re-attaching a URL, exactly as it does for a promotion.
   */
  const handleDeckRolledBack = useCallback(
    ({
      restoredQualityId,
      deckId,
    }: {
      restoredQualityId: string | null;
      deckId: DeckId;
    }) => {
      const restoredFile = restoredQualityId
        ? availableQualityFiles.find(
            (quality) => quality.id === restoredQualityId,
          )
        : undefined;
      const restoredElement = deck.getDeckElement(deckId);
      const restoredUrl = restoredElement?.currentSrc;

      if (!restoredFile || !restoredUrl) return;

      const restoredSource = buildQualityFileSource(restoredFile);
      seamlessAdoptionRef.current = {
        sourceId: restoredSource.id,
        url: restoredUrl,
        deckId,
      };
      setActiveQualityFileId(restoredQualityId);
      setActiveSource({ ...restoredSource, url: restoredUrl });
      setQualitySelectionNotice(t("player.qualitySwitchFailedReturnAuto"));
    },
    [availableQualityFiles, buildQualityFileSource, deck, t],
  );

  useEffect(() => {
    handleDeckPromotedRef.current = handleDeckPromoted;
    handleDeckRolledBackRef.current = handleDeckRolledBack;
  });

  /**
   * Releases the held frame once the new quality is painting, with a ceiling so
   * a source that never plays cannot leave a still image on screen forever.
   */
  useEffect(() => {
    if (!isHoldingFrame) return undefined;

    const video = videoRef.current;
    const release = () => setIsHoldingFrame(false);
    const ceiling = window.setTimeout(release, FRAME_HOLD_CEILING_MS);

    video?.addEventListener("playing", release);
    video?.addEventListener("seeked", release);
    video?.addEventListener("error", release);

    return () => {
      window.clearTimeout(ceiling);
      video?.removeEventListener("playing", release);
      video?.removeEventListener("seeked", release);
      video?.removeEventListener("error", release);
    };
  }, [deckEpoch, isHoldingFrame, videoRef]);

  useEffect(() => {
    applyQualityFileRef.current = applyQualityFile;
  });

  const handleSelectQualityMode = useCallback(
    (mode: Exclude<QualityPreferenceMode, "advanced">) => {
      const selectedFile =
        mode === "low-data"
          ? lowDataQualityFile
          : mode === "higher-resolution"
            ? higherResolutionQualityFile
            : selectAutoQuality(
                audioCompatibleQualityFiles,
                getFileQualitySelectionContext(
                  containerRef.current?.clientHeight ?? 720,
                  recentQualityStallsRef.current.length,
                ),
              );

      if (!selectedFile) {
        setQualitySelectionNotice(t("player.qualityManualUnavailable"));
        return;
      }

      void applyQualityFile(selectedFile, { mode }, { isManual: true });
    },
    [
      applyQualityFile,
      audioCompatibleQualityFiles,
      higherResolutionQualityFile,
      lowDataQualityFile,
      t,
    ],
  );

  const handleSelectAdvancedQuality = useCallback(
    (qualityId: string) => {
      const selectedFile = availableQualityFiles.find(
        (candidate) => candidate.id === qualityId,
      );

      if (!selectedFile) {
        setQualitySelectionNotice(t("player.qualityManualUnavailable"));
        return;
      }

      if (!isQualityAudioCompatible(selectedFile, selectedAudioStreamIndex)) {
        setQualitySelectionNotice(t("player.qualityAudioMismatch"));
        return;
      }

      void applyQualityFile(
        selectedFile,
        {
          mode: "advanced",
          preferredHeight: selectedFile.height,
          preferredQualityId: selectedFile.id,
          preferOriginal: selectedFile.kind === "original",
        },
        { isManual: true },
      );
    },
    [applyQualityFile, availableQualityFiles, selectedAudioStreamIndex, t],
  );

  const handleSelectAutoQuality = useCallback(async () => {
    if (hasFileQualities) {
      handleSelectQualityMode("auto");
      return;
    }
    const bestSource = availablePlaybackCandidates[0] ?? source;
    const defaultAudioIndex = getDefaultAudioStreamIndex(item, bestSource);
    let nextSource = bestSource;

    if (canInjectDefaultAudioIntoStreamCopy(bestSource, defaultAudioIndex)) {
      try {
        nextSource = await buildConfiguredSource(
          bestSource,
          undefined,
          defaultAudioIndex,
        );
      } catch (switchError) {
        console.warn(
          "[Seyirlik Playback] Could not build Auto quality source with default audio",
          switchError,
        );
      }
    }

    setSelectedQualityId(AUTO_QUALITY_ID);
    setSelectedAudioStreamIndex(defaultAudioIndex);
    setActiveAudioStreamIndex(
      shouldForceDefaultAudioInPlaybackUrl(nextSource) ||
        getStreamsOfType(nextSource, "Audio").length <= 1
        ? defaultAudioIndex
        : undefined,
    );

    const switchRequestToken = sourceSwitchTokenRef.current;

    void switchPlayerSource(nextSource).catch((switchError: unknown) => {
      if (sourceSwitchTokenRef.current !== switchRequestToken + 1) {
        return;
      }

      console.warn(
        "[Seyirlik Playback] Could not return to Auto quality with default audio",
        switchError,
      );
      void switchPlayerSource(bestSource);
    });
  }, [
    availablePlaybackCandidates,
    buildConfiguredSource,
    handleSelectQualityMode,
    hasFileQualities,
    item,
    source,
    switchPlayerSource,
  ]);

  const handleSelectQuality = useCallback(
    async (quality: PlaybackQualityOption) => {
      let nextSource: PlaybackSourceCandidate;

      try {
        nextSource = await buildConfiguredSource(activeSource, quality);
      } catch (switchError) {
        console.warn(
          "[Seyirlik Playback] Could not build quality source",
          switchError,
        );
        return;
      }

      setSelectedQualityId(quality.id);
      setActiveAudioStreamIndex(selectedAudioStreamIndex);

      void switchPlayerSource(nextSource).catch((switchError: unknown) => {
        console.warn(
          "[Seyirlik Playback] Could not switch quality",
          switchError,
        );
      });
    },
    [
      activeSource,
      buildConfiguredSource,
      selectedAudioStreamIndex,
      switchPlayerSource,
    ],
  );

  /**
   * Chooses the rendition Auto should be on. Kept in a ref so the listener
   * effect stays stable, and driven by measured buffer health because Safari
   * and Firefox do not implement `navigator.connection` — relying on it capped
   * Auto at 720p forever on those browsers.
   */
  useEffect(() => {
    reconsiderQualityRef.current = (recentStallCount: number) => {
      if (!activeQualityFile) return;
      // A switch already being prepared owns the decision. Re-entering here
      // would supersede it every review tick and nothing would ever promote.
      if (deck.isPreparing) return;
      const preference = qualityPreferenceRef.current;
      const video = videoRef.current;
      const ladder = [...audioCompatibleQualityFiles].sort(
        (left, right) => left.height - right.height,
      );
      const currentIndex = ladder.findIndex(
        (quality) => quality.id === activeQualityFile.id,
      );
      const struggling = recentStallCount >= 2;
      const comfortable =
        !struggling &&
        recentStallCount === 0 &&
        bufferedSecondsAhead(video) >= HEALTHY_BUFFER_SECONDS;
      let candidate: AvailableQualityFile | undefined;

      if (preference.mode === "auto") {
        const sizeTarget = selectAutoQuality(
          audioCompatibleQualityFiles,
          getFileQualitySelectionContext(
            measuredPlayerHeight(containerRef.current, video),
            recentStallCount,
          ),
        );
        if (struggling && currentIndex > 0) {
          // Repeated stalls: drop one rung rather than all the way down.
          candidate = ladder[currentIndex - 1];
        } else if (
          comfortable &&
          currentIndex >= 0 &&
          currentIndex < ladder.length - 1 &&
          ladder[currentIndex + 1].height <=
            displayTargetHeight(
              measuredPlayerHeight(containerRef.current, video),
              typeof window === "undefined" ? 1 : window.devicePixelRatio,
            ) *
              1.35
        ) {
          // Healthy buffer and the display can still use more detail: step up
          // one rung and let the next review decide whether to keep climbing.
          candidate = ladder[currentIndex + 1];
        } else {
          candidate = sizeTarget;
        }
      } else if (preference.mode === "higher-resolution") {
        candidate = struggling
          ? currentIndex > 0
            ? ladder[currentIndex - 1]
            : undefined
          : higherResolutionQualityFile;
      } else if (preference.mode === "low-data") {
        candidate = lowDataQualityFile;
      }

      if (!candidate || candidate.id === activeQualityFile.id) return;
      // A rung that just failed to prepare is left alone for a while rather
      // than retried on every review tick.
      if (isQualityBackedOff(candidate.id)) return;
      const now = Date.now();
      if (
        !shouldSwitchFileQuality({
          currentHeight: activeQualityFile.height,
          candidateHeight: candidate.height,
          now,
          lastSwitchAt: lastQualitySwitchAtRef.current,
          recentStallCount,
        })
      ) {
        return;
      }
      lastQualitySwitchAtRef.current = now;
      void applyQualityFileRef.current(candidate, preference, {
        isManual: false,
      });
    };
  });

  useEffect(() => {
    if (!hasFileQualities) return undefined;
    const video = videoRef.current;
    const container = containerRef.current;
    let resizeTimer: number | undefined;

    const pruneStalls = () => {
      const cutoff = Date.now() - 60_000;
      recentQualityStallsRef.current = recentQualityStallsRef.current.filter(
        (timestamp) => timestamp >= cutoff,
      );
      return recentQualityStallsRef.current.length;
    };
    // The callback is read through a ref so this effect never depends on
    // `switchPlayerSource`, whose identity changes on every progress tick. When
    // it did, the recovery interval was torn down and rebuilt several times a
    // second and could never actually reach its delay, so Auto never upgraded.
    const run = () => reconsiderQualityRef.current(pruneStalls());
    const handleWaiting = () => {
      if (!video || video.paused || video.currentTime <= 0) return;
      recentQualityStallsRef.current.push(Date.now());
      run();
    };
    const handleResize = () => {
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(run, 350);
    };

    video?.addEventListener("waiting", handleWaiting);
    const resizeObserver =
      container && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(handleResize)
        : undefined;
    if (container) resizeObserver?.observe(container);
    const recoveryInterval = window.setInterval(
      run,
      QUALITY_REVIEW_INTERVAL_MS,
    );
    return () => {
      video?.removeEventListener("waiting", handleWaiting);
      resizeObserver?.disconnect();
      window.clearInterval(recoveryInterval);
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
    };
  }, [deckEpoch, hasFileQualities, videoRef]);

  const completeFileQualityControls = useMemo<
    CompleteFileQualityControls | undefined
  >(() => {
    if (!hasFileQualities) return undefined;

    const autoQualityFile = selectAutoQuality(
      audioCompatibleQualityFiles,
      getFileQualitySelectionContext(
        containerRef.current?.clientHeight ?? 720,
        recentQualityStallsRef.current.length,
      ),
    );

    return {
      activeMode: fileQualityMode,
      effectiveQualityLabel: activeQualityFile
        ? `${activeQualityFile.height}p${activeQualityFile.hdr ? " HDR" : ""}`
        : undefined,
      modeQualityLabels: {
        "low-data": lowDataQualityFile
          ? `${lowDataQualityFile.height}p`
          : undefined,
        auto:
          fileQualityMode === "auto" && activeQualityFile
            ? `${activeQualityFile.height}p`
            : autoQualityFile
              ? `${autoQualityFile.height}p`
              : undefined,
        "higher-resolution": higherResolutionQualityFile
          ? `${higherResolutionQualityFile.height}p`
          : undefined,
      },
      advancedOptions: advancedQualityOptions,
      // The tick belongs on what the viewer asked for, not on what happens to
      // be decoding. A handoff can take a long time on a slow link, and marking
      // the old rung during it reads as "your click did nothing". While a
      // switch is preparing the pending rung is ticked; if it fails, the tick
      // falls back to whatever is actually playing.
      lockedQualityId:
        fileQualityMode === "advanced"
          ? (deck.pendingQualityId ?? activeQualityFile?.id)
          : undefined,
      preparingQualityId: deck.pendingQualityId ?? undefined,
      limitationsText:
        activeQualityFile?.kind === "generated"
          ? t("player.qualityCompleteFileLimitations")
          : undefined,
      noticeText: qualitySelectionNotice ?? undefined,
      onSelectMode: handleSelectQualityMode,
      onSelectAdvancedQuality: handleSelectAdvancedQuality,
    };
  }, [
    activeQualityFile,
    advancedQualityOptions,
    audioCompatibleQualityFiles,
    fileQualityMode,
    handleSelectAdvancedQuality,
    handleSelectQualityMode,
    hasFileQualities,
    higherResolutionQualityFile,
    lowDataQualityFile,
    qualitySelectionNotice,
    t,
  ]);

  const handleSelectAudioStream = useCallback(
    async (streamIndex: number) => {
      if (!canSwitchAudio) {
        return;
      }

      const video = videoRef.current;
      let shouldDeferActiveAudioUntilSourceSwitch = false;

      if (video && isDirectBrowserPlaybackSource(activeSource)) {
        const syncResult = tryApplyNativeAudioTrack(
          video,
          activeSource,
          streamIndex,
        );

        logAudioSourceDebug(
          "Native audio track switch attempted",
          video,
          activeSource,
          streamIndex,
          { syncResult },
        );

        if (syncResult.succeeded) {
          setSelectedAudioStreamIndex(streamIndex);
          setActiveAudioStreamIndex(streamIndex);
          revealPlayerChrome();
          return;
        }

        const mediaDefaultAudioIndex =
          getMediaSourceDefaultAudioStreamIndex(activeSource);

        if (
          syncResult.reason === "native-audio-tracks-unavailable" &&
          !didUserSelectNonDefaultAudio(streamIndex, mediaDefaultAudioIndex)
        ) {
          setSelectedAudioStreamIndex(streamIndex);
          setActiveAudioStreamIndex(streamIndex);
          console.info(
            "[Seyirlik Playback] Native audioTracks unavailable for the media default track; keeping direct playback.",
            {
              sourceMode: activeSource.mode,
              hlsKind: activeSource.hlsKind,
              selectedAudioStreamIndex: streamIndex,
              mediaDefaultAudioStreamIndex: mediaDefaultAudioIndex,
              nativeAudioTracks: getNativeAudioTrackSnapshot(video),
            },
          );
          revealPlayerChrome();
          return;
        }

        const currentNativeStreamIndex = getNativeActiveAudioStreamIndex(
          video,
          activeSource,
        );
        setActiveAudioStreamIndex(currentNativeStreamIndex);

        if (
          !getAudioFallbackSource(activeSource, availablePlaybackCandidates)
        ) {
          console.warn(
            "[Seyirlik Playback] Native audio switching failed and HLS fallback is unavailable",
            syncResult,
          );
          return;
        }

        shouldDeferActiveAudioUntilSourceSwitch = true;
      }

      const selectedQuality = qualityOptions.find(
        (quality) => quality.id === selectedQualityId,
      );
      const fallbackBaseSource =
        getAudioFallbackSource(activeSource, availablePlaybackCandidates) ??
        activeSource;
      let nextSource: PlaybackSourceCandidate;

      try {
        nextSource = await buildConfiguredSource(
          fallbackBaseSource,
          selectedQuality,
          streamIndex,
        );
      } catch (switchError) {
        console.warn(
          "[Seyirlik Playback] Could not build audio stream source",
          switchError,
        );
        return;
      }

      setSelectedAudioStreamIndex(streamIndex);
      setActiveAudioStreamIndex(
        shouldDeferActiveAudioUntilSourceSwitch ? undefined : streamIndex,
      );

      void switchPlayerSource(nextSource).catch((switchError: unknown) => {
        console.warn(
          "[Seyirlik Playback] Could not switch audio stream",
          switchError,
        );
      });
    },
    [
      activeSource,
      availablePlaybackCandidates,
      buildConfiguredSource,
      canSwitchAudio,
      item,
      qualityOptions,
      revealPlayerChrome,
      selectedQualityId,
      switchPlayerSource,
    ],
  );

  const clearFullscreenSeekPreviewFallbackTimer = useCallback(() => {
    if (fullscreenSeekPreviewFallbackTimerRef.current !== null) {
      window.clearTimeout(fullscreenSeekPreviewFallbackTimerRef.current);
      fullscreenSeekPreviewFallbackTimerRef.current = null;
    }
  }, []);

  const hideFullscreenSeekPreviewAfterPaint = useCallback(
    (token: number) => {
      const video = videoRef.current;

      const finish = () => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            const pendingPreview = pendingFullscreenSeekPreviewRef.current;

            if (!pendingPreview || pendingPreview.token !== token) {
              return;
            }

            pendingFullscreenSeekPreviewRef.current = null;
            clearFullscreenSeekPreviewFallbackTimer();
            setFullscreenSeekPreviewSeconds(null);
          });
        });
      };

      const videoWithFrameCallback = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
      };

      if (videoWithFrameCallback?.requestVideoFrameCallback) {
        videoWithFrameCallback.requestVideoFrameCallback(finish);
        return;
      }

      finish();
    },
    [clearFullscreenSeekPreviewFallbackTimer],
  );

  const handleSeekPreview = useCallback(
    (seconds: number) => {
      fullscreenSeekPreviewTokenRef.current += 1;
      const token = fullscreenSeekPreviewTokenRef.current;

      pendingFullscreenSeekPreviewRef.current = {
        token,
        targetSeconds: seconds,
      };

      clearFullscreenSeekPreviewFallbackTimer();
      fullscreenSeekPreviewFallbackTimerRef.current = window.setTimeout(() => {
        const pendingPreview = pendingFullscreenSeekPreviewRef.current;

        if (!pendingPreview || pendingPreview.token !== token) {
          return;
        }

        pendingFullscreenSeekPreviewRef.current = null;
        setFullscreenSeekPreviewSeconds(null);
      }, 3500);

      setFullscreenSeekPreviewSeconds(seconds);
      revealPlayerChrome();
    },
    [clearFullscreenSeekPreviewFallbackTimer, revealPlayerChrome],
  );

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    const handleSeekFrameReady = () => {
      const pendingPreview = pendingFullscreenSeekPreviewRef.current;

      if (!pendingPreview) {
        return;
      }

      const currentTime = Number.isFinite(video.currentTime)
        ? video.currentTime
        : 0;

      if (
        !video.ended &&
        Math.abs(currentTime - pendingPreview.targetSeconds) > 1.5
      ) {
        return;
      }

      hideFullscreenSeekPreviewAfterPaint(pendingPreview.token);
    };

    video.addEventListener("seeked", handleSeekFrameReady);
    video.addEventListener("canplay", handleSeekFrameReady);
    video.addEventListener("playing", handleSeekFrameReady);

    return () => {
      video.removeEventListener("seeked", handleSeekFrameReady);
      video.removeEventListener("canplay", handleSeekFrameReady);
      video.removeEventListener("playing", handleSeekFrameReady);
    };
  }, [deckEpoch, hideFullscreenSeekPreviewAfterPaint, videoRef]);

  const handleSelectSubtitleStream = useCallback(
    (streamIndex: number) => {
      setActiveSubtitleText("");
      setSelectedSubtitleStreamIndex(streamIndex);
      revealPlayerChrome();
    },
    [revealPlayerChrome],
  );

  useEffect(() => {
    const video = videoRef.current;
    const sourceToAttach = activeSource;
    const selectedAudioIndexForSource = selectedAudioIndexForActiveSource;

    if (!video) {
      return undefined;
    }

    /**
     * True when this run is only catching up with a deck promotion.
     *
     * The promoted element already holds these bytes, is decoded, and is
     * playing them. Re-attaching the URL here would tear all of that down and
     * put back exactly the reload this refactor removed, so the run binds
     * listeners and does nothing else.
     */
    const seamlessAdoption =
      seamlessAdoptionRef.current?.url === sourceToAttach.url &&
      seamlessAdoptionRef.current?.sourceId === sourceToAttach.id
        ? seamlessAdoptionRef.current
        : null;

    if (seamlessAdoption) {
      seamlessAdoptionRef.current = null;
    }

    // A promotion is a continuation, not a new playback. Resetting these would
    // re-announce a start that never stopped and re-open the progress report
    // the viewer is already inside.
    if (!pendingSourceRestoreRef.current && !seamlessAdoption) {
      hasStartedRef.current = false;
      lastProgressReportRef.current = 0;
    }

    let attachment: AttachedVideoSource | undefined;
    let didRestore = false;
    let didRequestAudioFallback = false;
    let isDisposed = false;
    const pendingRestore = pendingSourceRestoreRef.current;
    const selectedQuality = qualityOptions.find(
      (quality) => quality.id === selectedQualityId,
    );
    const attemptId = playbackAttemptIdRef.current + 1;
    const playbackAttempt = createPlaybackAttemptState(
      attemptId,
      sourceToAttach,
    );

    playbackAttemptIdRef.current = attemptId;
    playbackAttemptRef.current = playbackAttempt;

    const isCurrentAttempt = () =>
      !isDisposed &&
      playbackAttemptRef.current === playbackAttempt &&
      playbackAttemptIdRef.current === playbackAttempt.id;

    const applyInitialStartPosition = () => {
      if (
        !isCurrentAttempt() ||
        pendingRestore ||
        hasAppliedInitialStartRef.current
      ) {
        return;
      }

      hasAppliedInitialStartRef.current = true;

      const safeStartSeconds = Number.isFinite(initialStartSeconds)
        ? Math.max(0, initialStartSeconds)
        : 0;

      if (safeStartSeconds <= 0) {
        latestPlaybackPositionRef.current = 0;
        return;
      }

      try {
        const maxTime =
          Number.isFinite(video.duration) && video.duration > 0
            ? Math.max(0, video.duration - 0.25)
            : safeStartSeconds;

        const nextTime = Math.min(safeStartSeconds, maxTime);
        video.currentTime = nextTime;
        latestPlaybackPositionRef.current = nextTime;
      } catch (seekError) {
        console.warn(
          "[Seyirlik Playback] Could not apply saved playback position",
          seekError,
        );
      }
    };

    const requestPlayWhenAudioTranscodeReady = (
      reason: string,
      wasPlaying = true,
    ) => {
      if (!isCurrentAttempt()) {
        return;
      }

      if (!isAudioTranscodeSource(sourceToAttach)) {
        if (wasPlaying) {
          void video.play().catch((playError: unknown) => {
            if (!isCurrentAttempt()) {
              return;
            }

            console.info(
              "[Seyirlik Playback] Playback was blocked or deferred",
              playError,
            );
          });
        }
        return;
      }

      const token = sourceSwitchTokenRef.current;
      const existingPending = pendingAudioTranscodePlayRef.current;

      pendingAudioTranscodePlayRef.current =
        existingPending &&
        existingPending.token === token &&
        existingPending.attemptId === attemptId &&
        existingPending.reason === reason
          ? { ...existingPending, wasPlaying }
          : {
              token,
              attemptId,
              reason,
              wasPlaying,
              startedAt: Date.now(),
            };
      setIsWaitingForAudioTranscodeReady(wasPlaying);

      const tryStart = () => {
        const pending = pendingAudioTranscodePlayRef.current;

        if (
          isDisposed ||
          !isCurrentAttempt() ||
          !pending ||
          pending.token !== token ||
          pending.token !== sourceSwitchTokenRef.current ||
          pending.attemptId !== attemptId
        ) {
          return;
        }

        if (!pending.wasPlaying) {
          pendingAudioTranscodePlayRef.current = null;
          clearAudioTranscodeReadinessTimer();
          setIsWaitingForAudioTranscodeReady(false);
          video.pause();
          return;
        }

        if (Date.now() - pending.startedAt > 7000) {
          pendingAudioTranscodePlayRef.current = null;
          clearAudioTranscodeReadinessTimer();
          setIsWaitingForAudioTranscodeReady(false);
          console.warn(
            "[Seyirlik Playback] Audio-transcode readiness wait timed out; starting anyway",
            {
              reason: pending.reason,
              readyState: video.readyState,
              currentTime: video.currentTime,
              buffered: Array.from(
                { length: video.buffered.length },
                (_, index) => ({
                  start: video.buffered.start(index),
                  end: video.buffered.end(index),
                }),
              ),
              source: {
                mode: sourceToAttach.mode,
                hlsKind: sourceToAttach.hlsKind,
                url: redactPlaybackUrl(sourceToAttach.url),
              },
            },
          );
          void video.play().catch((playError: unknown) => {
            if (!isCurrentAttempt()) {
              return;
            }

            console.info(
              "[Seyirlik Playback] Audio-transcode playback was blocked or deferred",
              playError,
            );
          });
          return;
        }

        if (!isVideoReadyForAudioTranscodePlayback(video)) {
          clearAudioTranscodeReadinessTimer();

          audioTranscodeReadinessTimerRef.current = window.setTimeout(() => {
            tryStart();
          }, 120);

          return;
        }

        pendingAudioTranscodePlayRef.current = null;
        clearAudioTranscodeReadinessTimer();
        setIsWaitingForAudioTranscodeReady(false);

        console.info(
          "[Seyirlik Playback] Audio-transcode HLS is ready; starting playback",
          {
            reason: pending.reason,
            readyState: video.readyState,
            currentTime: video.currentTime,
            buffered: Array.from(
              { length: video.buffered.length },
              (_, index) => ({
                start: video.buffered.start(index),
                end: video.buffered.end(index),
              }),
            ),
            source: {
              mode: sourceToAttach.mode,
              hlsKind: sourceToAttach.hlsKind,
              url: redactPlaybackUrl(sourceToAttach.url),
            },
          },
        );

        void video.play().catch((playError: unknown) => {
          if (!isCurrentAttempt()) {
            return;
          }

          console.info(
            "[Seyirlik Playback] Audio-transcode playback was blocked or deferred",
            playError,
          );
        });
      };

      clearAudioTranscodeReadinessTimer();
      tryStart();
    };

    const retryPendingAudioTranscodePlay = () => {
      const pending = pendingAudioTranscodePlayRef.current;

      if (
        !pending ||
        pending.token !== sourceSwitchTokenRef.current ||
        pending.attemptId !== attemptId ||
        !isCurrentAttempt()
      ) {
        return;
      }

      requestPlayWhenAudioTranscodeReady(pending.reason, pending.wasPlaying);
    };

    let wasPlayingBeforeAudioTranscodeSeek = false;

    const handleAudioTranscodeSeeking = () => {
      if (!isCurrentAttempt() || !isAudioTranscodeSource(sourceToAttach)) {
        return;
      }

      wasPlayingBeforeAudioTranscodeSeek = !video.paused && !video.ended;

      if (wasPlayingBeforeAudioTranscodeSeek) {
        video.pause();
      }

      pendingAudioTranscodePlayRef.current = {
        token: sourceSwitchTokenRef.current,
        attemptId,
        reason: "seek-audio-transcode-buffering",
        wasPlaying: wasPlayingBeforeAudioTranscodeSeek,
        startedAt: Date.now(),
      };
      setIsWaitingForAudioTranscodeReady(wasPlayingBeforeAudioTranscodeSeek);

      console.info(
        "[Seyirlik Playback] Waiting for audio-transcode HLS after seek",
        {
          currentTime: video.currentTime,
          wasPlayingBeforeSeek: wasPlayingBeforeAudioTranscodeSeek,
          readyState: video.readyState,
          bufferedLength: video.buffered.length,
        },
      );
    };

    const handleAudioTranscodeSeeked = () => {
      if (!isCurrentAttempt() || !isAudioTranscodeSource(sourceToAttach)) {
        return;
      }

      requestPlayWhenAudioTranscodeReady(
        "seeked-audio-transcode-buffering",
        wasPlayingBeforeAudioTranscodeSeek,
      );
    };

    const restorePlayback = () => {
      if (
        !isCurrentAttempt() ||
        !pendingRestore ||
        didRestore ||
        pendingRestore.token !== sourceSwitchTokenRef.current
      ) {
        return;
      }

      didRestore = true;

      try {
        video.volume = pendingRestore.volume;
        video.muted = pendingRestore.muted;
        video.playbackRate = pendingRestore.playbackRate;
        setSelectedAudioStreamIndex(pendingRestore.selectedAudioStreamIndex);
        setSelectedSubtitleStreamIndex(
          pendingRestore.selectedSubtitleStreamIndex,
        );
        if (pendingRestore.currentTime > 0) {
          const maxTime =
            Number.isFinite(video.duration) && video.duration > 0
              ? Math.max(0, video.duration - 0.25)
              : pendingRestore.currentTime;
          video.currentTime = Math.min(pendingRestore.currentTime, maxTime);
        }
      } catch (seekError) {
        console.warn(
          "[Seyirlik Playback] Could not restore playback position after source switch",
          seekError,
        );
      }

      pendingSourceRestoreRef.current = null;

      if (pendingRestore.wasPlaying) {
        requestPlayWhenAudioTranscodeReady(
          "restore-playback-after-source-switch",
          true,
        );
      } else {
        pendingAudioTranscodePlayRef.current = null;
        clearAudioTranscodeReadinessTimer();
        setIsWaitingForAudioTranscodeReady(false);
        video.pause();
      }

      refreshProgress();
    };

    const requestHlsAudioFallback = async (reason: string) => {
      const fallbackBaseSource = getAudioFallbackSource(
        sourceToAttach,
        availablePlaybackCandidates,
      );

      if (
        didRequestAudioFallback ||
        isDisposed ||
        !isCurrentAttempt() ||
        selectedAudioIndexForSource === undefined ||
        !fallbackBaseSource
      ) {
        return;
      }

      didRequestAudioFallback = true;

      let fallbackSource: PlaybackSourceCandidate;

      try {
        fallbackSource = await buildConfiguredSource(
          fallbackBaseSource,
          selectedQuality,
          selectedAudioIndexForSource,
        );
      } catch (fallbackError) {
        console.warn(
          "[Seyirlik Playback] Could not build HLS fallback for default audio",
          fallbackError,
        );
        return;
      }

      setSelectedAudioStreamIndex(selectedAudioIndexForSource);
      setActiveAudioStreamIndex(undefined);

      console.info("[Seyirlik Playback] Falling back to HLS for audio track", {
        reason,
        selectedAudioStreamIndex: selectedAudioIndexForSource,
        sourceMode: sourceToAttach.mode,
        sourceUrl: redactPlaybackUrl(sourceToAttach.url),
        fallbackUrl: redactPlaybackUrl(fallbackSource.url),
      });

      void switchPlayerSource(fallbackSource).catch((switchError: unknown) => {
        if (!isCurrentAttempt()) {
          return;
        }

        console.warn(
          "[Seyirlik Playback] Could not switch to HLS fallback for audio track",
          switchError,
        );
        setActiveAudioStreamIndex(
          getNativeActiveAudioStreamIndex(video, sourceToAttach),
        );
      });
    };

    const syncNativeAudioTrack = (eventName: string) => {
      if (isDisposed || didRequestAudioFallback || !isCurrentAttempt()) {
        return;
      }

      const audioStreamCount = getStreamsOfType(sourceToAttach, "Audio").length;

      if (!isDirectBrowserPlaybackSource(sourceToAttach)) {
        setActiveAudioStreamIndex(selectedAudioIndexForSource);
        logAudioSourceDebug(
          `Audio source attached (${eventName})`,
          video,
          sourceToAttach,
          selectedAudioIndexForSource,
          { syncResult: { reason: "hls-or-transcoded-source" } },
        );
        return;
      }

      if (audioStreamCount <= 1) {
        setActiveAudioStreamIndex(selectedAudioIndexForSource);
        logAudioSourceDebug(
          `Audio source attached (${eventName})`,
          video,
          sourceToAttach,
          selectedAudioIndexForSource,
          { syncResult: { reason: "single-audio-stream" } },
        );
        return;
      }

      const syncResult = tryApplyNativeAudioTrack(
        video,
        sourceToAttach,
        selectedAudioIndexForSource,
      );

      const currentNativeStreamIndex = syncResult.succeeded
        ? selectedAudioIndexForSource
        : getNativeActiveAudioStreamIndex(video, sourceToAttach);

      setActiveAudioStreamIndex(
        currentNativeStreamIndex ?? selectedAudioIndexForSource,
      );

      logAudioSourceDebug(
        `Native audio sync (${eventName})`,
        video,
        sourceToAttach,
        selectedAudioIndexForSource,
        { syncResult, currentNativeStreamIndex },
      );

      if (syncResult.succeeded) {
        return;
      }

      const mediaDefaultAudioIndex =
        getMediaSourceDefaultAudioStreamIndex(sourceToAttach);
      const userNeedsDifferentAudio = didUserSelectNonDefaultAudio(
        selectedAudioIndexForSource,
        mediaDefaultAudioIndex,
      );
      const nativeAudioControlUnavailable =
        syncResult.reason === "native-audio-tracks-unavailable" ||
        syncResult.reason === "native-track-match-not-found";

      if (!userNeedsDifferentAudio && nativeAudioControlUnavailable) {
        setActiveAudioStreamIndex(
          mediaDefaultAudioIndex ?? selectedAudioIndexForSource,
        );
        console.info(
          "[Seyirlik Playback] Preserving DirectPlay because native audioTracks are unavailable and the default audio should already be selected by the media element",
          {
            reason: syncResult.reason,
            eventName,
            sourceMode: sourceToAttach.mode,
            hlsKind: sourceToAttach.hlsKind,
            selectedAudioStreamIndex: selectedAudioIndexForSource,
            mediaDefaultAudioStreamIndex: mediaDefaultAudioIndex,
            audioStreamCount,
            nativeAudioTracks: getNativeAudioTrackSnapshot(video),
          },
        );
        return;
      }

      if (userNeedsDifferentAudio) {
        requestHlsAudioFallback(syncResult.reason);
        return;
      }

      console.info(
        "[Seyirlik Playback] Keeping direct playback; native audioTracks unavailable is not a playback failure",
        {
          reason: syncResult.reason,
          eventName,
          sourceMode: sourceToAttach.mode,
          hlsKind: sourceToAttach.hlsKind,
          selectedAudioStreamIndex: selectedAudioIndexForSource,
          mediaDefaultAudioStreamIndex: mediaDefaultAudioIndex,
          audioStreamCount,
          nativeAudioTracks: getNativeAudioTrackSnapshot(video),
        },
      );
    };

    const handleLoadedMetadataAudio = () =>
      syncNativeAudioTrack("loadedmetadata");
    const handleLoadedDataAudio = () => syncNativeAudioTrack("loadeddata");
    const handleCanPlayAudio = () => syncNativeAudioTrack("canplay");
    const handleDurationChangeAudio = () =>
      syncNativeAudioTrack("durationchange");
    let startupWatchdogTimer: number | null = null;
    let hasStartupPlaybackSignal = false;
    let lastObservedCurrentTime = video.currentTime;

    const clearStartupWatchdog = (markCancelled = true) => {
      if (startupWatchdogTimer === null) {
        return;
      }

      window.clearTimeout(startupWatchdogTimer);
      startupWatchdogTimer = null;

      if (markCancelled) {
        markStartupWatchdogCancelled(playbackAttempt);
      }
    };

    const clearPlaybackErrorIfHealthy = (snapshot: PlaybackVideoSnapshot) => {
      if (isPlaybackStartupHealthy(snapshot)) {
        setLastVideoError(null);
        onVideoRecovery();
      }
    };

    const buildFailurePayload = (
      message: string,
      cause: string,
      snapshot: PlaybackVideoSnapshot,
      extra: Record<string, unknown> = {},
    ) => ({
      message,
      cause,
      source: {
        mode: sourceToAttach.mode,
        isHls: sourceToAttach.isHls,
        hlsKind: sourceToAttach.hlsKind,
        usingHlsJs: attachment?.usingHlsJs ?? sourceToAttach.usingHlsJs,
        url: redactPlaybackUrl(sourceToAttach.url),
        urlParams: getPlaybackUrlDebugParams(sourceToAttach.url),
      },
      video: {
        readyState: snapshot.readyState,
        networkState: snapshot.networkState,
        paused: snapshot.paused,
        currentTime: snapshot.currentTime,
        duration: snapshot.duration,
        bufferedRanges: snapshot.bufferedRanges,
      },
      diagnostics: buildPlaybackStartupDiagnostics({
        attempt: playbackAttempt,
        activeAttemptId: playbackAttemptIdRef.current,
        snapshot,
      }),
      ...extra,
    });

    const reportAttemptFailure = (
      cause: string,
      message: string,
      extra: Record<string, unknown> = {},
    ) => {
      const snapshot = getVideoSnapshot(video);
      const suppression = getFatalPlaybackSuppression(
        playbackAttempt,
        playbackAttemptIdRef.current,
        snapshot,
      );

      if (suppression.reason === "playback-healthy") {
        clearStartupWatchdog();
      } else if (!suppression.suppress && cause !== "startup-watchdog") {
        clearStartupWatchdog();
      }

      const payload = buildFailurePayload(message, cause, snapshot, {
        ...extra,
        suppressed: suppression.suppress,
        suppressionReason: suppression.reason,
      });

      if (suppression.suppress) {
        if (suppression.reason === "playback-healthy") {
          clearPlaybackErrorIfHealthy(snapshot);
        }

        console.info(
          "[Seyirlik Playback] Ignored stale or healthy playback failure",
          payload,
        );
        return false;
      }

      const details = JSON.stringify(payload, null, 2);

      console.error("[Seyirlik Playback] Fatal playback failure", payload);
      setLastVideoError(details);
      onVideoFailure(details);
      return true;
    };

    const markStartupPlaybackSignal = (eventName: string) => {
      if (!isCurrentAttempt()) {
        return;
      }

      const isHlsBufferSignal = eventName.startsWith("hls:");

      if (
        !isHlsBufferSignal &&
        isAudioTranscodeSource(sourceToAttach) &&
        !isVideoReadyForAudioTranscodePlayback(video)
      ) {
        return;
      }

      hasStartupPlaybackSignal = true;
      recordSuccessfulPlaybackEvent(playbackAttempt, eventName);
      clearStartupWatchdog();
      setLastVideoError(null);
      onVideoRecovery();
    };

    const handleStartupTimeUpdate = () => {
      if (!isCurrentAttempt()) {
        return;
      }

      const nextCurrentTime = video.currentTime;

      if (nextCurrentTime > 0 && nextCurrentTime > lastObservedCurrentTime) {
        markStartupPlaybackSignal("timeupdate-currentTime-advanced");
      }

      lastObservedCurrentTime = nextCurrentTime;
    };

    const handleStartupPlayableBuffer = (eventName: string) => {
      if (!isCurrentAttempt()) {
        return;
      }

      const snapshot = getVideoSnapshot(video);

      if (hasPlayableBuffer(snapshot)) {
        markStartupPlaybackSignal(`${eventName}-playable-buffer`);
      } else {
        clearPlaybackErrorIfHealthy(snapshot);
      }
    };

    const handleStartupError = () => {
      if (!isCurrentAttempt()) {
        return;
      }

      clearStartupWatchdog();
    };

    const handleStartupStalled = () => {
      if (!isCurrentAttempt()) {
        return;
      }

      console.info("[Seyirlik Playback] Temporary media stall", {
        attemptId: playbackAttempt.id,
        sourceMode: sourceToAttach.mode,
        hlsKind: sourceToAttach.hlsKind,
        currentTime: video.currentTime,
        readyState: video.readyState,
        bufferedRanges: getVideoSnapshot(video).bufferedRanges,
      });
    };

    const handleStartupLoadedData = () =>
      markStartupPlaybackSignal("loadeddata");
    const handleStartupCanPlay = () => markStartupPlaybackSignal("canplay");
    const handleStartupPlaying = () => markStartupPlaybackSignal("playing");
    const handleStartupLoadedDataBuffer = () =>
      handleStartupPlayableBuffer("loadeddata");
    const handleStartupProgressBuffer = () =>
      handleStartupPlayableBuffer("progress");
    const handleStartupCanPlayThroughBuffer = () =>
      handleStartupPlayableBuffer("canplaythrough");

    const startStartupWatchdog = () => {
      if (!isCurrentAttempt()) {
        return;
      }

      clearStartupWatchdog(false);

      startupWatchdogTimer = window.setTimeout(() => {
        startupWatchdogTimer = null;

        if (!isCurrentAttempt()) {
          return;
        }

        const snapshot = getVideoSnapshot(video);

        if (hasStartupPlaybackSignal || isPlaybackStartupHealthy(snapshot)) {
          recordSuccessfulPlaybackEvent(
            playbackAttempt,
            hasStartupPlaybackSignal
              ? (playbackAttempt.lastSuccessfulPlaybackEvent ??
                  "startup-watchdog-existing-success")
              : "startup-watchdog-playback-healthy",
          );
          clearPlaybackErrorIfHealthy(snapshot);
          return;
        }

        if (shouldExtendStartupWatchdog(playbackAttempt, snapshot)) {
          console.info(
            "[Seyirlik Playback] Startup watchdog extended while direct media is still loading",
            {
              attemptId: playbackAttempt.id,
              elapsedStartupMs: Date.now() - playbackAttempt.startedAtMs,
              readyState: snapshot.readyState,
              networkState: snapshot.networkState,
              bufferedRanges: snapshot.bufferedRanges,
            },
          );
          startStartupWatchdog();
          return;
        }

        if (
          isAudioTranscodeSource(sourceToAttach) &&
          pendingAudioTranscodePlayRef.current?.attemptId === attemptId
        ) {
          console.info(
            "[Seyirlik Playback] Startup watchdog extended while waiting for audio-transcode readiness",
            {
              readyState: video.readyState,
              currentTime: video.currentTime,
              bufferedLength: video.buffered.length,
              source: {
                mode: sourceToAttach.mode,
                hlsKind: sourceToAttach.hlsKind,
                url: redactPlaybackUrl(sourceToAttach.url),
              },
            },
          );

          startStartupWatchdog();
          return;
        }

        console.warn(
          "[Seyirlik Playback] Startup watchdog detected stalled playback",
          buildFailurePayload(
            "Playback did not start within startup watchdog timeout.",
            "startup-watchdog",
            snapshot,
          ),
        );
        reportAttemptFailure(
          "startup-watchdog",
          "Playback did not start within startup watchdog timeout.",
        );
      }, playbackAttempt.startupWatchdogMs);
    };

    try {
      const sourceUrlParams = getPlaybackUrlDebugParams(sourceToAttach.url);

      if (
        sourceToAttach.mode === "Transcoding" &&
        isMasterHlsPlaybackUrl(sourceToAttach.url) &&
        String(sourceUrlParams.EnableAutoStreamCopy).toLowerCase() === "true"
      ) {
        console.warn(
          "[Seyirlik Playback] Bad mixed transcoding/stream-copy source detected",
          {
            mode: sourceToAttach.mode,
            isHls: sourceToAttach.isHls,
            hlsKind: sourceToAttach.hlsKind,
            url: redactPlaybackUrl(sourceToAttach.url),
            urlParams: sourceUrlParams,
          },
        );
      }

      attachment = seamlessAdoption
        ? // The deck controller already owns this element's source. Recording
          // an attachment that clears it on teardown would let an unrelated
          // re-run of this effect blank the playing deck.
          undefined
        : attachSourceToVideo(
            video,
            sourceToAttach.url,
            sourceToAttach.mimeType,
            {
              onHlsEvent: (event) => {
                if (!isCurrentAttempt()) {
                  return;
                }

                recordHlsEvent(playbackAttempt, event.name);

                if (isHlsStartupSuccessEvent(event.name)) {
                  markStartupPlaybackSignal(`hls:${event.name}`);
                }
              },
              onHlsFatalError: (data) => {
                if (!isCurrentAttempt()) {
                  return;
                }

                reportAttemptFailure(
                  "hls-fatal-error",
                  "hls.js reported a fatal playback error.",
                  { hlsError: getSerializableHlsError(data) },
                );
              },
            },
          );
      playbackAttempt.source = {
        ...playbackAttempt.source,
        usingHlsJs: attachment?.usingHlsJs ?? false,
      };
      activeAttachmentRef.current = attachment ?? null;

      setActiveSource((currentSource) =>
        currentSource.id === sourceToAttach.id &&
        currentSource.url === sourceToAttach.url
          ? { ...currentSource, usingHlsJs: attachment?.usingHlsJs ?? false }
          : currentSource,
      );
      console.info(
        seamlessAdoption
          ? "[Seyirlik Playback] Adopted promoted deck"
          : "[Seyirlik Playback] Attached playback source",
        {
          mode: sourceToAttach.mode,
          isHls: sourceToAttach.isHls,
          hlsKind: sourceToAttach.hlsKind,
          usingHlsJs: attachment?.usingHlsJs ?? false,
          deckId: seamlessAdoption?.deckId,
          url: redactPlaybackUrl(sourceToAttach.url),
          urlParams: sourceUrlParams,
        },
      );
      video.addEventListener("loadedmetadata", applyInitialStartPosition);
      video.addEventListener("canplay", applyInitialStartPosition);
      video.addEventListener("loadedmetadata", restorePlayback);
      video.addEventListener("canplay", restorePlayback);
      video.addEventListener("loadedmetadata", handleLoadedMetadataAudio);
      video.addEventListener("loadeddata", handleLoadedDataAudio);
      video.addEventListener("canplay", handleCanPlayAudio);
      video.addEventListener("durationchange", handleDurationChangeAudio);
      video.addEventListener("loadedmetadata", retryPendingAudioTranscodePlay);
      video.addEventListener("loadeddata", retryPendingAudioTranscodePlay);
      video.addEventListener("canplay", retryPendingAudioTranscodePlay);
      video.addEventListener("canplaythrough", retryPendingAudioTranscodePlay);
      video.addEventListener("progress", retryPendingAudioTranscodePlay);
      video.addEventListener("durationchange", retryPendingAudioTranscodePlay);
      video.addEventListener("seeking", handleAudioTranscodeSeeking);
      video.addEventListener("seeked", handleAudioTranscodeSeeked);
      video.addEventListener("loadeddata", handleStartupLoadedData);
      video.addEventListener("canplay", handleStartupCanPlay);
      video.addEventListener("playing", handleStartupPlaying);
      video.addEventListener("loadeddata", handleStartupLoadedDataBuffer);
      video.addEventListener("progress", handleStartupProgressBuffer);
      video.addEventListener(
        "canplaythrough",
        handleStartupCanPlayThroughBuffer,
      );
      video.addEventListener("timeupdate", handleStartupTimeUpdate);
      video.addEventListener("stalled", handleStartupStalled);
      video.addEventListener("error", handleStartupError);
      syncNativeAudioTrack("source-attached");

      // A promoted deck is already loaded, already decoded and already obeying
      // the play/pause intent the handoff transferred to it. Loading it,
      // watching it for a cold start, or autoplaying it again would each
      // interrupt playback that is not interrupted.
      if (!seamlessAdoption) {
        video.load();
        startStartupWatchdog();
        if (!pendingRestore && !partyWatch.shouldDeferAutoplay) {
          requestPlayWhenAudioTranscodeReady("initial-autoplay", true);
        }
      }
    } catch (attachError) {
      reportAttemptFailure(
        "source-attach-error",
        attachError instanceof Error
          ? attachError.message
          : String(attachError),
      );
    }

    return () => {
      isDisposed = true;
      clearStartupWatchdog();
      pendingAudioTranscodePlayRef.current = null;
      clearAudioTranscodeReadinessTimer();
      setIsWaitingForAudioTranscodeReady(false);
      video.removeEventListener("loadedmetadata", applyInitialStartPosition);
      video.removeEventListener("canplay", applyInitialStartPosition);
      video.removeEventListener("loadedmetadata", restorePlayback);
      video.removeEventListener("canplay", restorePlayback);
      video.removeEventListener("loadedmetadata", handleLoadedMetadataAudio);
      video.removeEventListener("loadeddata", handleLoadedDataAudio);
      video.removeEventListener("canplay", handleCanPlayAudio);
      video.removeEventListener("durationchange", handleDurationChangeAudio);
      video.removeEventListener(
        "loadedmetadata",
        retryPendingAudioTranscodePlay,
      );
      video.removeEventListener("loadeddata", retryPendingAudioTranscodePlay);
      video.removeEventListener("canplay", retryPendingAudioTranscodePlay);
      video.removeEventListener(
        "canplaythrough",
        retryPendingAudioTranscodePlay,
      );
      video.removeEventListener("progress", retryPendingAudioTranscodePlay);
      video.removeEventListener(
        "durationchange",
        retryPendingAudioTranscodePlay,
      );
      video.removeEventListener("seeking", handleAudioTranscodeSeeking);
      video.removeEventListener("seeked", handleAudioTranscodeSeeked);
      video.removeEventListener("loadeddata", handleStartupLoadedData);
      video.removeEventListener("canplay", handleStartupCanPlay);
      video.removeEventListener("playing", handleStartupPlaying);
      video.removeEventListener("loadeddata", handleStartupLoadedDataBuffer);
      video.removeEventListener("progress", handleStartupProgressBuffer);
      video.removeEventListener(
        "canplaythrough",
        handleStartupCanPlayThroughBuffer,
      );
      video.removeEventListener("timeupdate", handleStartupTimeUpdate);
      video.removeEventListener("stalled", handleStartupStalled);
      video.removeEventListener("error", handleStartupError);

      if (activeAttachmentRef.current === attachment) {
        activeAttachmentRef.current = null;
      }

      if (playbackAttemptRef.current === playbackAttempt) {
        playbackAttemptIdRef.current += 1;
        playbackAttemptRef.current = null;
      }

      // The deck the controller is holding for rollback keeps its source until
      // the promoted deck has proved stable. Clearing it here would remove the
      // only thing a rollback has to fall back to.
      if (isRetainedDeckElement(video)) {
        return;
      }

      try {
        attachment?.destroy();
      } catch (destroyError) {
        console.warn(
          "[Seyirlik Playback] Could not destroy video attachment during cleanup",
          destroyError,
        );
      }
    };
  }, [
    activeSource.id,
    activeSource.hlsKind,
    activeSource.isHls,
    activeSource.mimeType,
    activeSource.mode,
    activeSource.url,
    clearAudioTranscodeReadinessTimer,
    deckEpoch,
    initialStartSeconds,
    isRetainedDeckElement,
    onVideoFailure,
    onVideoRecovery,
    partyWatch.shouldDeferAutoplay,
    refreshProgress,
    selectedAudioIndexForActiveSource,
  ]);

  useEffect(() => {
    return () => {
      clearFullscreenSeekPreviewFallbackTimer();
      clearSeekFeedbackTimers();
      clearSeekFeedbackSpinTimers();
      clearSeekFeedbackChromeHideTimer();

      resetTouchSeekSession();

      pendingAudioTranscodePlayRef.current = null;
      clearAudioTranscodeReadinessTimer();
      setIsWaitingForAudioTranscodeReady(false);

      reportStoppedOnce(false);
    };
  }, [
    clearAudioTranscodeReadinessTimer,
    clearFullscreenSeekPreviewFallbackTimer,
    clearSeekFeedbackChromeHideTimer,
    clearSeekFeedbackSpinTimers,
    clearSeekFeedbackTimers,
    reportStoppedOnce,
    resetTouchSeekSession,
  ]);

  useEffect(() => {
    const handlePageExit = () => {
      reportStoppedOnce(true);
      void stopCustomPlaybackSessionImmediately(activeSource, {
        keepalive: true,
      }).catch((stopError) => {
        console.warn(
          "[Seyirlik Playback] Could not stop custom playback session during page exit",
          stopError,
        );
      });
    };

    window.addEventListener("pagehide", handlePageExit);
    window.addEventListener("beforeunload", handlePageExit);

    return () => {
      window.removeEventListener("pagehide", handlePageExit);
      window.removeEventListener("beforeunload", handlePageExit);
    };
  }, [activeSource, reportStoppedOnce]);

  useEffect(() => {
    const reportCurrentPlaybackProgress = (force = false) => {
      const video = videoRef.current;

      if (!video || video.ended) {
        return;
      }

      if (video.paused) {
        if (force) {
          reportPlaybackProgressCheckpoint(true, true);
        }

        return;
      }

      reportPlaybackProgressCheckpoint(false, force);
    };

    const intervalId = window.setInterval(
      () => reportCurrentPlaybackProgress(false),
      PLAYBACK_PROGRESS_REPORT_INTERVAL_MS,
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        reportCurrentPlaybackProgress(true);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeSource.id, reportPlaybackProgressCheckpoint]);

  useEffect(() => {
    setActiveSubtitleText("");
    setSubtitleCues([]);

    if (selectedSubtitleStreamIndex < 0 || !activeSource.mediaSourceId) {
      return undefined;
    }

    const subtitleStream = getStreamByIndex(
      activeSourceWithLibraryStreams,
      "Subtitle",
      selectedSubtitleStreamIndex,
    );

    if (!subtitleStream) {
      return undefined;
    }

    const abortController = new AbortController();
    const subtitleUrl = buildSubtitleStreamUrl(
      activeSource.playSessionId ?? "",
      selectedSubtitleStreamIndex,
    );

    const loadSubtitleCues = async () => {
      try {
        const response = await fetch(subtitleUrl, {
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`Subtitle request failed with ${response.status}`);
        }

        const subtitleText = await response.text();

        if (!abortController.signal.aborted) {
          setSubtitleCues(parseSubtitleCues(subtitleText));
        }
      } catch (subtitleError) {
        if (!abortController.signal.aborted) {
          console.warn(
            "[Seyirlik Subtitles] Could not load subtitle stream",
            subtitleError,
          );
        }
      }
    };

    void loadSubtitleCues();

    return () => {
      abortController.abort();
    };
  }, [
    activeSource.itemId,
    activeSource.mediaSource,
    activeSource.mediaSourceId,
    selectedSubtitleStreamIndex,
  ]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || subtitleCues.length === 0) {
      setActiveSubtitleText("");
      return undefined;
    }

    const syncSubtitleText = () => {
      const nextSubtitleText = getActiveSubtitleTextForTime(
        subtitleCues,
        video.currentTime - subtitleDelaySeconds,
      );
      setActiveSubtitleText((currentSubtitleText) =>
        currentSubtitleText === nextSubtitleText
          ? currentSubtitleText
          : nextSubtitleText,
      );
    };

    syncSubtitleText();

    video.addEventListener("loadedmetadata", syncSubtitleText);
    video.addEventListener("play", syncSubtitleText);
    video.addEventListener("pause", syncSubtitleText);
    video.addEventListener("seeking", syncSubtitleText);
    video.addEventListener("seeked", syncSubtitleText);
    video.addEventListener("timeupdate", syncSubtitleText);

    const intervalId = window.setInterval(syncSubtitleText, 120);

    return () => {
      video.removeEventListener("loadedmetadata", syncSubtitleText);
      video.removeEventListener("play", syncSubtitleText);
      video.removeEventListener("pause", syncSubtitleText);
      video.removeEventListener("seeking", syncSubtitleText);
      video.removeEventListener("seeked", syncSubtitleText);
      video.removeEventListener("timeupdate", syncSubtitleText);
      window.clearInterval(intervalId);
    };
  }, [deckEpoch, subtitleCues, subtitleDelaySeconds, videoRef]);

  /**
   * Both decks carry the same handlers, so every one of them has to establish
   * that the event came from the deck the viewer is actually watching.
   *
   * Without these guards, a standby that is buffering, seeking, priming or
   * failing would report a pause the viewer did not make, a stop that did not
   * happen, and progress from a position nobody is at.
   */
  type DeckMediaEvent = { currentTarget: EventTarget };

  const handleVideoPlay = (event: DeckMediaEvent) => {
    if (!isActiveDeckElement(event.currentTarget)) return;

    if (!hasStartedRef.current) {
      hasStartedRef.current = true;
      onPlaybackStarted?.(videoRef.current?.currentTime ?? 0);
    }
  };

  const handleVideoPause = (event: DeckMediaEvent) => {
    // The outgoing deck is paused as part of every handoff. By then it is no
    // longer the active deck, so this correctly reads as machinery rather than
    // as the viewer reaching for the space bar.
    if (!isActiveDeckElement(event.currentTarget)) return;

    reportPlaybackProgressCheckpoint(true, true);
  };

  const handleVideoSeeked = (event: DeckMediaEvent) => {
    if (!isActiveDeckElement(event.currentTarget)) return;

    // A standby prepared for where the viewer used to be must never be
    // promoted there.
    notifyActiveSeek();
    reportPlaybackProgressCheckpoint(videoRef.current?.paused ?? false, true);
  };

  const handleTimeUpdate = (event: DeckMediaEvent) => {
    if (!isActiveDeckElement(event.currentTarget)) return;

    reportPlaybackProgressCheckpoint(false);
  };

  const handleVideoError = (event: DeckMediaEvent) => {
    if (!isActiveDeckElement(event.currentTarget)) return;

    const video = videoRef.current;

    if (!video) {
      return;
    }

    const attempt = playbackAttemptRef.current;
    const snapshot = getVideoSnapshot(video);

    if (attempt) {
      const suppression = getFatalPlaybackSuppression(
        attempt,
        playbackAttemptIdRef.current,
        snapshot,
      );

      if (suppression.suppress) {
        if (suppression.reason === "playback-healthy") {
          setLastVideoError(null);
        }

        console.info("[Seyirlik Playback] Ignored video element error", {
          suppressionReason: suppression.reason,
          diagnostics: buildPlaybackStartupDiagnostics({
            attempt,
            activeAttemptId: playbackAttemptIdRef.current,
            snapshot,
          }),
        });
        return;
      }

      const payload = {
        message: "Video element reported a fatal playback error.",
        cause: "video-element-error",
        source: {
          mode: attempt.source.mode,
          isHls: attempt.source.isHls,
          hlsKind: attempt.source.hlsKind,
          usingHlsJs: attempt.source.usingHlsJs ?? null,
          url: redactPlaybackUrl(attempt.source.url),
          urlParams: getPlaybackUrlDebugParams(attempt.source.url),
        },
        video: {
          readyState: snapshot.readyState,
          networkState: snapshot.networkState,
          paused: snapshot.paused,
          currentTime: snapshot.currentTime,
          duration: snapshot.duration,
          bufferedRanges: snapshot.bufferedRanges,
        },
        diagnostics: buildPlaybackStartupDiagnostics({
          attempt,
          activeAttemptId: playbackAttemptIdRef.current,
          snapshot,
        }),
        mediaError: getVideoErrorDetails(video, attempt.source),
      };
      const details = JSON.stringify(payload, null, 2);

      setLastVideoError(details);
      console.error("[Seyirlik Playback] video element error", payload);
      onVideoFailure(details);
      return;
    }

    if (isPlaybackStartupHealthy(snapshot)) {
      setLastVideoError(null);
    }

    console.info(
      "[Seyirlik Playback] Ignored video element error without an active playback attempt",
      {
        sourceId: activeSource.id,
        sourceMode: activeSource.mode,
        readyState: snapshot.readyState,
        networkState: snapshot.networkState,
        currentTime: snapshot.currentTime,
        paused: snapshot.paused,
      },
    );
  };

  const getTouchSeekSide = (clientX: number): TouchSeekSide | null => {
    const bounds = containerRef.current?.getBoundingClientRect();

    if (!bounds) {
      return null;
    }

    return clientX - bounds.left < bounds.width / 2 ? "left" : "right";
  };

  const scheduleTouchSeekSessionExpiry = () => {
    clearTouchSeekSessionTimeout();

    touchSeekSessionRef.current.timeoutId = window.setTimeout(() => {
      touchSeekSessionRef.current.lastTapTime = 0;
      touchSeekSessionRef.current.lastTapSide = null;
      touchSeekSessionRef.current.isActive = false;
      touchSeekSessionRef.current.accumulatedSeconds = 0;
      touchSeekSessionRef.current.timeoutId = null;
    }, TOUCH_SEEK_SESSION_TIMEOUT_MS);
  };

  const seekByTouchSide = (side: TouchSeekSide, now: number) => {
    const seconds = side === "left" ? -5 : 5;
    const session = touchSeekSessionRef.current;
    const isContinuingSameSide = session.lastTapSide === side;

    session.lastTapTime = now;
    session.lastTapSide = side;
    session.isActive = true;
    session.accumulatedSeconds = isContinuingSameSide
      ? session.accumulatedSeconds + seconds
      : seconds;

    handleSeekBy(seconds);
    scheduleTouchSeekSessionExpiry();
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>): boolean => {
    if (
      isDraggingSubtitle ||
      isResizingSubtitle ||
      Date.now() < suppressPlayerTapUntilRef.current
    ) {
      return false;
    }

    const target = event.target as HTMLElement | null;

    const tappedInteractiveElement = target?.closest(
      "button, a, input, [role='slider'], [data-player-settings-root], [data-player-queue-root], [data-party-watch-root], [data-subtitle-editor-root]",
    );

    if (tappedInteractiveElement) {
      return false;
    }

    if (event.pointerType !== "touch") {
      return false;
    }

    const now = Date.now();
    const tappedSide = getTouchSeekSide(event.clientX);

    if (!tappedSide) {
      return false;
    }

    const session = touchSeekSessionRef.current;

    if (session.isActive) {
      if (session.lastTapSide === tappedSide) {
        clearSingleTapTimer();
        event.preventDefault();
        seekByTouchSide(tappedSide, now);
        revealPlayerChrome();
        return true;
      }

      resetTouchSeekSession(false);
    }

    if (
      touchSeekSessionRef.current.lastTapSide === tappedSide &&
      now - touchSeekSessionRef.current.lastTapTime <
        TOUCH_DOUBLE_TAP_THRESHOLD_MS
    ) {
      clearSingleTapTimer();
      event.preventDefault();
      touchSeekSessionRef.current.accumulatedSeconds = 0;
      seekByTouchSide(tappedSide, now);
      revealPlayerChrome();
      return true;
    }

    resetTouchSeekSession(false);
    touchSeekSessionRef.current.lastTapTime = now;
    touchSeekSessionRef.current.lastTapSide = tappedSide;

    suppressMouseMoveUntilRef.current = now + 500;

    if (isViewModeEnabled) {
      partyWatch.togglePlay();
    } else if (shouldShowPlayerChrome) {
      setIsSettingsOpen(false);
      setIsQueueOpen(false);
      setIsPlaybackInfoOpen(false);
      setIsPartyWatchOpen(false);
      setIsSubtitleEditMode(false);
      setAreControlsManuallyHidden(true);
      releaseControlsHover();
    } else {
      revealPlayerChrome();
    }

    return true;
  };

  const handlePlayerOverlayToggle = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        isDraggingSubtitle ||
        isResizingSubtitle ||
        Date.now() < suppressPlayerTapUntilRef.current
      ) {
        return;
      }

      const target = event.target as HTMLElement | null;

      const tappedInteractiveElement = target?.closest(
        "button, a, input, [role='slider'], [data-player-settings-root], [data-player-queue-root], [data-party-watch-root], [data-subtitle-editor-root]",
      );

      if (tappedInteractiveElement) {
        return;
      }

      if (isViewModeEnabled) {
        if (event.pointerType !== "touch") {
          partyWatch.togglePlay();
        }

        return;
      }

      if (shouldShowPlayerChrome) {
        setIsSettingsOpen(false);
        setIsQueueOpen(false);
        setIsPlaybackInfoOpen(false);
        setIsPartyWatchOpen(false);
        setIsSubtitleEditMode(false);
        setAreControlsManuallyHidden(true);
        releaseControlsHover();
        return;
      }

      revealPlayerChrome();
    },
    [
      isDraggingSubtitle,
      isResizingSubtitle,
      isViewModeEnabled,
      partyWatch,
      releaseControlsHover,
      revealPlayerChrome,
      shouldShowPlayerChrome,
    ],
  );

  const handlePlayerMouseMove = useCallback(() => {
    if (Date.now() < suppressMouseMoveUntilRef.current) {
      return;
    }

    if (isViewModeEnabled) {
      revealViewModeCursor();
      return;
    }

    revealPlayerChrome();
  }, [isViewModeEnabled, revealPlayerChrome, revealViewModeCursor]);

  const releaseTouchFocusAndControlsHover = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch") {
        return;
      }

      const activeElement = document.activeElement;

      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }

      window.setTimeout(() => {
        releaseControlsHover();
      }, 120);
    },
    [releaseControlsHover],
  );

  const getSubtitlePositionFromPoint = useCallback(
    (clientX: number, clientY: number): SubtitlePosition | null => {
      const bounds = containerRef.current?.getBoundingClientRect();
      const dragState = subtitleDragStateRef.current;

      if (!bounds || !dragState) {
        return null;
      }

      return {
        x: clamp(
          ((clientX - bounds.left - dragState.offsetX) / bounds.width) * 100,
          8,
          92,
        ),
        y: clamp(
          ((clientY - bounds.top - dragState.offsetY) / bounds.height) * 100,
          10,
          90,
        ),
      };
    },
    [],
  );

  const handleSubtitleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    startSubtitleEditMode();
  };

  const handleSubtitleResizePointerDown = (
    event: PointerEvent<HTMLButtonElement>,
    directionX: -1 | 1,
    directionY: -1 | 1,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    event.currentTarget.setPointerCapture(event.pointerId);

    subtitleResizeStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScale: subtitleSize.scale,
      directionX,
      directionY,
    };

    setIsSubtitleEditMode(true);
    setIsResizingSubtitle(true);
    setIsDraggingSubtitle(false);
    subtitleDragStateRef.current = null;
    resetTouchSeekSession();
    revealPlayerChrome();
  };

  const handleSubtitleResizePointerMove = (
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    const resizeState = subtitleResizeStateRef.current;

    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const deltaX =
      (event.clientX - resizeState.startClientX) * resizeState.directionX;
    const deltaY =
      (event.clientY - resizeState.startClientY) * resizeState.directionY;
    const strongestDelta =
      Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    const nextScale = clamp(
      resizeState.startScale + strongestDelta / 220,
      MIN_SUBTITLE_SCALE,
      MAX_SUBTITLE_SCALE,
    );

    setSubtitleSize({ scale: nextScale });
  };

  const finishSubtitleResize = (event: PointerEvent<HTMLButtonElement>) => {
    const resizeState = subtitleResizeStateRef.current;

    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    subtitleResizeStateRef.current = null;
    setIsResizingSubtitle(false);
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    resetTouchSeekSession();
  };

  const handleSubtitleResizePointerCancel = (
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    if (subtitleResizeStateRef.current?.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    subtitleResizeStateRef.current = null;
    setIsResizingSubtitle(false);
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    resetTouchSeekSession();
  };

  const handleSubtitlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!isSubtitleEditMode) {
      return;
    }

    const bounds = containerRef.current?.getBoundingClientRect();
    const overlayBounds = subtitleOverlayRef.current?.getBoundingClientRect();

    if (!bounds || !overlayBounds) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const overlayCenterX = overlayBounds.left + overlayBounds.width / 2;
    const overlayCenterY = overlayBounds.top + overlayBounds.height / 2;

    subtitleDragStateRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - overlayCenterX,
      offsetY: event.clientY - overlayCenterY,
    };

    setSubtitlePosition(
      (currentPosition) =>
        currentPosition ?? {
          x: clamp(
            ((overlayCenterX - bounds.left) / bounds.width) * 100,
            8,
            92,
          ),
          y: clamp(
            ((overlayCenterY - bounds.top) / bounds.height) * 100,
            10,
            90,
          ),
        },
    );
    setIsDraggingSubtitle(true);
    setIsResizingSubtitle(false);
    subtitleResizeStateRef.current = null;
    resetTouchSeekSession();
    revealPlayerChrome();
  };

  const handleSubtitlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = subtitleDragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const nextPosition = getSubtitlePositionFromPoint(
      event.clientX,
      event.clientY,
    );

    if (nextPosition) {
      setSubtitlePosition(nextPosition);
    }
  };

  const finishSubtitleDrag = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = subtitleDragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const nextPosition = getSubtitlePositionFromPoint(
      event.clientX,
      event.clientY,
    );

    if (nextPosition) {
      setSubtitlePosition(nextPosition);
    }

    subtitleDragStateRef.current = null;
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    setIsDraggingSubtitle(false);
    resetTouchSeekSession();
  };

  const handleSubtitlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (subtitleDragStateRef.current?.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    subtitleDragStateRef.current = null;
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    setIsDraggingSubtitle(false);
    setIsResizingSubtitle(false);
    resetTouchSeekSession();
  };

  const subtitle = getItemSubtitle(item, mediaFormatLabels);
  const isEpisodeItem = item.Type === "Episode";
  const playerHeaderTitle = isEpisodeItem
    ? item.SeriesName?.trim() || title
    : title;
  const episodeSeasonNumber =
    isEpisodeItem &&
    typeof item.ParentIndexNumber === "number" &&
    Number.isFinite(item.ParentIndexNumber)
      ? item.ParentIndexNumber
      : null;
  const episodeNumber =
    isEpisodeItem &&
    typeof item.IndexNumber === "number" &&
    Number.isFinite(item.IndexNumber)
      ? item.IndexNumber
      : null;
  const playerEpisodeLabel =
    episodeSeasonNumber !== null && episodeNumber !== null
      ? formatTemplate(t("player.seasonEpisodeLabel"), {
          season: episodeSeasonNumber,
          episode: episodeNumber,
        })
      : null;
  const episodeMetadata = isEpisodeItem
    ? getEpisodeDisplayMetadata(item, language)
    : null;
  const playerEpisodeName = isEpisodeItem
    ? episodeMetadata?.title?.trim() || item.Name.trim() || null
    : null;
  const playerSeriesLogoItemId = isEpisodeItem
    ? (item.ParentLogoItemId ?? item.SeriesId ?? null)
    : null;
  const fallbackTitleLogoUrl =
    playerSeriesLogoItemId && item.ParentLogoImageTag
      ? getLogoImageUrl(playerSeriesLogoItemId, item.ParentLogoImageTag, 900)
      : item.ImageTags?.Logo
        ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 900)
        : "";
  const titleLogoUrl = getItemLogoUrlById(
    playerSeriesLogoItemId ?? item.Id,
    language,
    fallbackTitleLogoUrl,
  );
  const playerHeaderSubtitle = isEpisodeItem
    ? (playerEpisodeName ?? subtitle)
    : subtitle;
  const isSubtitleBeingEdited =
    isDraggingSubtitle || isResizingSubtitle || isSubtitleEditMode;
  const isShowingSubtitlePlaceholder =
    isSubtitleBeingEdited && activeSubtitleText.trim().length === 0;

  const subtitleLines = (
    isShowingSubtitlePlaceholder
      ? t("player.subtitleEditPlaceholder")
      : activeSubtitleText
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const subtitleOverlayStyle = subtitlePosition
    ? {
        left: `${subtitlePosition.x}%`,
        top: `${subtitlePosition.y}%`,
        transform: `translate(-50%, -50%) scale(${subtitleSize.scale})`,
      }
    : {
        transform: `translateX(-50%) scale(${subtitleSize.scale})`,
      };
  const isCenterPlayPauseLoading =
    (progress.isBuffering ||
      isWaitingForAudioTranscodeReady ||
      fullscreenSeekPreview !== null) &&
    !error;
  const isCompactPhonePlayer =
    Math.min(viewport.width, viewport.height) < 640 &&
    Math.max(viewport.width, viewport.height) < 1024;

  const seekPointerAxis = "horizontal";

  return (
    <div
      ref={containerRef}
      className={`seyirlik-player-shell fixed inset-0 select-none ${
        // eslint-disable-next-line no-constant-condition -- deliberately off
        isCompactPhonePlayer && false ? "seyirlik-player-shell--phone" : "" //TODO - false for now
      } z-50 min-h-0 overflow-hidden bg-black text-white ${
        shouldShowPlayerCursor ? "cursor-default" : "cursor-none"
      }`}
      onMouseMove={handlePlayerMouseMove}
      onPointerUpCapture={releaseTouchFocusAndControlsHover}
      onPointerCancelCapture={releaseTouchFocusAndControlsHover}
      onPointerUp={(event) => {
        const wasTouchSeekHandled = handlePointerUp(event);

        if (!wasTouchSeekHandled) {
          handlePlayerOverlayToggle(event);
        }
      }}
    >
      {/*
        The two decks.

        Both fill the same viewport at full size — no `display: none`, no
        one-pixel box, nothing that would stop the standby decoding — and only
        opacity and stacking decide which decoded frame is on screen. The
        standby is inert: no pointer events, out of the accessibility tree, and
        not focusable, so the active deck remains the only one the viewer and
        the controls can reach.

        The crossfade is deliberately shorter than four frames. It covers a
        single-frame timing seam at the swap and is far too brief to read as a
        dissolve, and because both layers hold a real picture it never fades
        through the black background behind them.
      */}
      {(["a", "b"] as const).map((deckId) => {
        const isActiveDeck = deckId === deck.activeDeckId;

        return (
          <video
            key={deckId}
            ref={deckRefs[deckId]}
            data-deck={deckId}
            data-deck-role={isActiveDeck ? "active" : "standby"}
            controls={false}
            playsInline
            preload="auto"
            aria-hidden={isActiveDeck ? undefined : true}
            tabIndex={isActiveDeck ? undefined : -1}
            className={`seyirlik-video absolute inset-0 h-full w-full object-contain ${
              isActiveDeck
                ? "z-[2] opacity-100"
                : "pointer-events-none z-[1] opacity-0"
            }`}
            style={{
              transition: shouldReduceMotion
                ? undefined
                : `opacity ${HANDOFF_CROSSFADE_MS}ms linear`,
            }}
            onPlay={handleVideoPlay}
            onPause={handleVideoPause}
            onTimeUpdate={handleTimeUpdate}
            onSeeked={handleVideoSeeked}
            onWaiting={(event) => {
              // Standby buffering is not the viewer waiting, and must not
              // reveal the chrome or count as an Auto-quality stall.
              if (!isActiveDeckElement(event.currentTarget)) return;
              revealPlayerChrome();
            }}
            onError={handleVideoError}
            onEnded={(event) => {
              if (!isActiveDeckElement(event.currentTarget)) return;
              const positionSeconds = updateLatestPlaybackPosition();
              onPlaybackProgress?.(positionSeconds, true);
              reportStoppedOnce(false);
              handleDefaultNextEpisodePlay();
            }}
          />
        );
      })}

      {/*
        Development-only readout of which media is genuinely on screen. A
        handoff is invisible by design, so without this there is no way to tell
        a switch that worked from one that silently declined.
      */}
      {import.meta.env.DEV ? (
        <ActiveSourceBadge
          videoRef={videoRef}
          activeDeckId={deck.activeDeckId}
          deckEpoch={deckEpoch}
          activeQualityId={activeQualityFileId}
          activeQualityLabel={
            activeQualityFile
              ? `${activeQualityFile.height}p${activeQualityFile.kind === "original" ? " original" : ""}`
              : undefined
          }
          pendingQualityId={deck.pendingQualityId}
        />
      ) : null}

      {/*
        The outgoing frame, held over the element while it reloads.

        No longer part of a rendition change: those hand over between decks and
        never blank anything, so there is no frame to hold. This is only for the
        changes that still have to replace the source in place — an audio track
        needing a different encode, an HLS session, a title change.
      */}
      <canvas
        ref={frameHoldCanvasRef}
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 z-[11] h-full w-full bg-black object-contain transition-opacity duration-200 ${
          isHoldingFrame ? "opacity-100" : "opacity-0"
        }`}
      />

      {/*
        Warms bytes for the source replacements that cannot hand over between
        decks. A rendition change no longer comes through here: the standby deck
        is the thing that buffers it, and that deck goes on to play it.
      */}
      <video
        ref={preloadVideoRef}
        aria-hidden="true"
        tabIndex={-1}
        muted
        playsInline
        preload="none"
        className="pointer-events-none absolute h-px w-px opacity-0"
      />

      <AnimatePresence initial={false}>
        {showPreparingArtwork ? (
          <motion.div
            key="player-preparing-artwork"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-[12] overflow-hidden bg-black"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: shouldReduceMotion ? 0 : 0.45,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            {preparingBackdropUrl ? (
              <motion.img
                src={preparingBackdropUrl}
                alt=""
                draggable={false}
                className="absolute inset-0 h-full w-full object-cover"
                initial={{
                  opacity: 0,
                  scale: shouldReduceMotion ? 1 : 1.035,
                }}
                animate={{
                  opacity: 1,
                  scale: 1.02,
                }}
                exit={{
                  opacity: 0,
                  scale: shouldReduceMotion ? 1 : 1.01,
                }}
                transition={{
                  opacity: {
                    duration: shouldReduceMotion ? 0 : 0.5,
                  },
                  scale: {
                    duration: shouldReduceMotion ? 0 : 1.2,
                    ease: [0.22, 1, 0.36, 1],
                  },
                }}
              />
            ) : null}

            <div className="absolute inset-0 bg-black/45" />

            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-black/45" />

            <div className="absolute inset-0 z-10 grid place-items-center">
              <LoadingSpinner label="" />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {!isViewModeEnabled ? (
        <>
          <div
            aria-hidden="true"
            className={`seyirlik-player-gradient-top pointer-events-none absolute inset-x-0 top-0 z-[8] h-[26%] transition-opacity duration-300 ${
              shouldRenderPlayerChrome ? "opacity-100" : "opacity-0"
            }`}
          />
          <div
            aria-hidden="true"
            className={`seyirlik-player-gradient-bottom pointer-events-none absolute inset-x-0 bottom-0 z-[8] h-[38%] transition-opacity duration-300 ${
              shouldRenderPlayerChrome ? "opacity-100" : "opacity-0"
            }`}
          />
        </>
      ) : null}

      {fullscreenSeekPreview && fullscreenSeekPreviewRect ? (
        <div className="pointer-events-none absolute inset-0 z-[9] overflow-hidden">
          <div
            className="absolute overflow-hidden bg-black"
            style={{
              left: `${fullscreenSeekPreviewRect.left}px`,
              top: `${fullscreenSeekPreviewRect.top}px`,
              width: `${fullscreenSeekPreviewRect.width}px`,
              height: `${fullscreenSeekPreviewRect.height}px`,
            }}
          >
            <div
              className="absolute inset-0 opacity-95"
              style={{
                backgroundImage: `url("${fullscreenSeekPreview.imageUrl}")`,
                backgroundSize: `${TRICKPLAY_COLUMNS * 100}% ${
                  TRICKPLAY_ROWS * 100
                }%`,
                backgroundPosition: `${getSpritePositionPercent(
                  fullscreenSeekPreview.column,
                  TRICKPLAY_COLUMNS,
                )}% ${getSpritePositionPercent(
                  fullscreenSeekPreview.row,
                  TRICKPLAY_ROWS,
                )}%`,
                backgroundRepeat: "no-repeat",
              }}
            />

            <div className="absolute inset-0 bg-black/22" />
          </div>
        </div>
      ) : null}

      {subtitleLines.length > 0 ? (
        <div
          ref={subtitleOverlayRef}
          data-subtitle-editor-root
          className={`seyirlik-subtitle-overlay absolute z-[24] ${
            subtitlePosition
              ? ""
              : "seyirlik-subtitle-overlay--default bottom-[12%] left-1/2"
          } ${isSubtitleEditMode ? (isDraggingSubtitle ? "cursor-grabbing" : "cursor-grab") : "cursor-default"} ${
            isShowingSubtitlePlaceholder
              ? "seyirlik-subtitle-overlay--placeholder"
              : ""
          } ${isSubtitleEditMode ? "seyirlik-subtitle-overlay--editing" : ""}`}
          style={subtitleOverlayStyle}
          onPointerDown={handleSubtitlePointerDown}
          onPointerMove={handleSubtitlePointerMove}
          onPointerUp={finishSubtitleDrag}
          onPointerCancel={handleSubtitlePointerCancel}
          onLostPointerCapture={handleSubtitlePointerCancel}
          onDoubleClick={handleSubtitleDoubleClick}
          aria-label={t("player.dragSubtitles")}
        >
          {subtitleLines.map((line, index) => (
            <div
              key={`${line}-${index}`}
              className="seyirlik-subtitle-line-wrap"
            >
              <span className="seyirlik-subtitle-line">{line}</span>
            </div>
          ))}

          {isSubtitleEditMode ? (
            <>
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--tl"
                aria-label={t("player.resizeSubtitlesTopLeft")}
                onPointerDown={(event) =>
                  handleSubtitleResizePointerDown(event, -1, -1)
                }
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--tr"
                aria-label={t("player.resizeSubtitlesTopRight")}
                onPointerDown={(event) =>
                  handleSubtitleResizePointerDown(event, 1, -1)
                }
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--bl"
                aria-label={t("player.resizeSubtitlesBottomLeft")}
                onPointerDown={(event) =>
                  handleSubtitleResizePointerDown(event, -1, 1)
                }
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--br"
                aria-label={t("player.resizeSubtitlesBottomRight")}
                onPointerDown={(event) =>
                  handleSubtitleResizePointerDown(event, 1, 1)
                }
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {isSubtitleEditMode ? (
        <button
          type="button"
          data-subtitle-editor-root
          onClick={finishSubtitleEditMode}
          className="pointer-events-auto absolute right-[max(0.85rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-[72] rounded-full border border-white/15 bg-black/70 px-4 py-2 text-sm font-black text-white shadow-player-controls backdrop-blur-xl transition hover:bg-white/[0.14] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        >
          {t("player.finishSubtitleEdit")}
        </button>
      ) : null}

      {!isViewModeEnabled && !isSubtitleEditMode ? (
        <>
          <PlayerOverlay
            title={playerHeaderTitle}
            titleLogoUrl={titleLogoUrl}
            episodeLabel={playerEpisodeLabel}
            episodeName={playerEpisodeName}
            subtitle={playerHeaderSubtitle}
            backTo={backTo ?? getMediaOwnerRouteForItem(item)}
            visible={shouldRenderPlayerChrome || isTimelinePreparing}
            isPlaying={progress.isPlaying}
            isPlayPausePending={
              partyWatch.isInGroup && partyWatch.isPlayPausePending
            }
            isPlayPauseLoading={isCenterPlayPauseLoading}
            notice={notice}
            onTogglePlay={partyWatch.togglePlay}
            onControlsHoverStart={keepControlsVisible}
            onControlsHoverEnd={releaseControlsHover}
            seekFeedback={seekFeedback}
            topRightControls={
              <div
                className="seyirlik-player-top-actions relative flex flex-col items-end gap-3"
                data-party-watch-root
              >
                <div className="seyirlik-player-top-actions-row flex items-center gap-2">
                  <PlaybackInfoButton
                    source={sourceWithLiveTranscodingReasons}
                    onClick={() => {
                      setIsPlaybackInfoOpen(true);
                      setIsQueueOpen(false);
                    }}
                  />

                  <Tooltip
                    content={t("player.enterViewMode")}
                    group="top-right"
                  >
                    <button
                      type="button"
                      onClick={enterViewMode}
                      className="relative flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition-[backdrop-filter] hover:bg-white/[0.12] hover:backdrop-blur-lg hover:duration-1000 duration-[500ms] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                      aria-label={t("player.enterViewMode")}
                    >
                      <EyeOff size={18} />
                    </button>
                  </Tooltip>

                  <Tooltip content={t("party.title")} group="top-right">
                    <button
                      type="button"
                      onClick={() => {
                        setIsPartyWatchOpen((current) => !current);
                        setIsSettingsOpen(false);
                        setIsQueueOpen(false);
                        revealPlayerChrome();
                      }}
                      className="relative flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition-[backdrop-filter] hover:bg-white/[0.12] hover:backdrop-blur-lg hover:duration-1000 duration-[500ms] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                      aria-label={t("party.title")}
                    >
                      <Users
                        size={18}
                        fill={partyWatch.isInGroup ? "#fff" : "none"}
                      />

                      <span
                        className="pointer-events-none absolute inset-0"
                        aria-hidden="true"
                      >
                        {partyWatch.isInGroup ? (
                          Array.from({ length: visiblePartyWatchDotCount }).map(
                            (_, index) => {
                              const dotPosition =
                                PARTY_WATCH_DOT_POSITIONS[index] ??
                                PARTY_WATCH_DOT_POSITIONS[0];

                              return (
                                <span
                                  key={`${dotPosition}-${index}`}
                                  className={`absolute ${dotPosition} h-1.5 w-1.5 rounded-full border border-white/85 bg-white/85 shadow-accent-dot`}
                                />
                              );
                            },
                          )
                        ) : (
                          <span className="absolute right-[0.35rem] top-[0.50rem] h-1.5 w-1.5 rounded-full border border-white/85 bg-transparent" />
                        )}
                      </span>
                    </button>
                  </Tooltip>

                  <Tooltip content={checkpointButtonLabel} group="top-right">
                    <button
                      type="button"
                      onClick={toggleCheckpointMode}
                      className={`relative flex h-11 w-11 items-center justify-center rounded-full transition-[backdrop-filter] hover:backdrop-blur-lg hover:duration-1000 duration-[500ms] ease focus:outline-none focus:ring-2 focus:ring-[var(--accent)] ${
                        checkpointSeconds !== null
                          ? " text-[var(--accent)] ring-0 ring-[var(--accent)]/45 hover:bg-white/[0.12]"
                          : "text-white/85 hover:bg-white/[0.12] hover:text-white"
                      }`}
                      aria-label={checkpointButtonLabel}
                      aria-pressed={checkpointSeconds !== null}
                    >
                      <Bookmark
                        size={18}
                        fill={
                          checkpointSeconds !== null ? "currentColor" : "none"
                        }
                      />
                    </button>
                  </Tooltip>
                </div>

                {isPartyWatchOpen ? (
                  <div
                    className="seyirlik-party-panel-anchor absolute right-0 top-full mt-3"
                    data-party-watch-root
                  >
                    <PartyWatchControls controller={partyWatch} visible />
                  </div>
                ) : null}
              </div>
            }
          />

          <SkipSegmentButton
            segment={skippableActiveSegment}
            label={skipSegmentLabel}
            shouldReduceMotion={shouldReduceMotion}
            onSkip={handleSkipSegment}
            onControlsHoverStart={keepControlsVisible}
            onControlsHoverEnd={releaseControlsHover}
          />

          <AnimatePresence initial={false}>
            {shouldShowDefaultNextEpisodeCountdown &&
            nextEpisode &&
            defaultNextEpisodeCountdownSeconds !== null ? (
              <NextEpisodeCountdownOverlay
                key={`${item.Id}-${nextEpisode.Id}`}
                nextEpisode={nextEpisode}
                secondsRemaining={defaultNextEpisodeCountdownSeconds}
                shouldReduceMotion={shouldReduceMotion}
                onPlayNow={handleDefaultNextEpisodePlay}
                onCancel={handleDefaultNextEpisodeCancel}
                onControlsHoverStart={keepControlsVisible}
                onControlsHoverEnd={releaseControlsHover}
              />
            ) : null}
          </AnimatePresence>

          {isPartyWatchOpen ? (
            <PartyWatchOverlay controller={partyWatch} />
          ) : null}

          <PlayerControls
            visible={shouldRenderPlayerChrome}
            isPlaying={progress.isPlaying}
            playWaiting={partyWatch.isInGroup && partyWatch.isPlayPausePending}
            onControlsHoverStart={keepControlsVisible}
            onControlsHoverEnd={releaseControlsHover}
            seekPreviewLoading={fullscreenSeekPreview !== null}
            seekPointerAxis={seekPointerAxis}
            compactSeekPreview={isCompactPhonePlayer}
            compactLayout={isCompactPhonePlayer}
            currentTime={progress.currentTime}
            duration={progress.duration}
            bufferedEnd={progress.bufferedEnd}
            volume={progress.volume}
            muted={progress.muted}
            itemId={item.Id}
            mediaSourceId={activeSource.mediaSourceId}
            checkpointSeconds={checkpointSeconds}
            previewAspectRatio={previewAspectRatio}
            onTogglePlay={partyWatch.togglePlay}
            onSeek={partyWatch.seekTo}
            onSeekPreview={handleSeekPreview}
            onSeekBy={handleSeekBy}
            onToggleMute={progress.toggleMute}
            onVolumeChange={progress.setVolume}
            onToggleFullscreen={toggleFullscreen}
            playbackQueue={playbackQueue}
            queueOpen={isQueueOpen}
            onOpenQueue={() => {
              setIsQueueOpen((current) => !current);
              setIsSettingsOpen(false);
              setIsPartyWatchOpen(false);
              revealPlayerChrome();
            }}
            onPlayQueueItem={onPlayQueueItem ? handlePlayQueueItem : undefined}
            onOpenSettings={() => {
              setIsSettingsOpen((current) => !current);
              setIsQueueOpen(false);
              setIsPartyWatchOpen(false);
              revealPlayerChrome();
            }}
            source={sourceWithLiveTranscodingReasons}
            qualityOptions={qualityOptions}
            selectedQualityId={selectedQualityId}
            selectedAudioStreamIndex={activeAudioStreamIndex}
            selectedSubtitleStreamIndex={selectedSubtitleStreamIndex}
            subtitleDelaySeconds={subtitleDelaySeconds}
            canSwitchAudio={canSwitchAudio}
            canSwitchSubtitles={canSwitchSubtitles}
            completeFileQuality={completeFileQualityControls}
            isSubtitleEditMode={isSubtitleEditMode}
            settingsOpen={isSettingsOpen}
            onSelectAutoQuality={handleSelectAutoQuality}
            onSelectQuality={handleSelectQuality}
            onSelectAudioStream={handleSelectAudioStream}
            onSelectSubtitleStream={handleSelectSubtitleStream}
            onSubtitleDelayChange={setSubtitleDelaySeconds}
            onStartSubtitleEdit={startSubtitleEditMode}
          />
        </>
      ) : null}

      {isViewModeEnabled ? (
        <div className="pointer-events-auto absolute left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[70] flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/25 p-1 text-white/35 opacity-25 backdrop-blur-md transition hover:bg-black/55 hover:text-white hover:opacity-100 focus-within:opacity-100">
          {checkpointSeconds !== null ? (
            <Tooltip content={t("player.returnToCheckpoint")} group="top-right">
              <button
                type="button"
                onClick={toggleCheckpointMode}
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                aria-label={t("player.returnToCheckpoint")}
              >
                <Bookmark size={16} fill="currentColor" />
              </button>
            </Tooltip>
          ) : null}

          <Tooltip content={t("player.exitViewMode")}>
            <button
              type="button"
              onClick={exitViewMode}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              aria-label={t("player.exitViewMode")}
            >
              <Eye size={16} />
            </button>
          </Tooltip>
        </div>
      ) : null}

      {!isViewModeEnabled && displayedPartyEventMessage ? (
        <div className="pointer-events-none absolute bottom-[calc(max(1rem,env(safe-area-inset-bottom))+5.8rem)] left-[max(1rem,env(safe-area-inset-left))] z-40">
          <div
            className={`rounded-full border-[var(--accent)]/35 bg-black/72 px-3 py-1.5 text-xs font-bold text-white/[0.88] shadow-player-controls backdrop-blur-xl will-change-transform ${
              isPartyEventToastLeaving
                ? "animate-[partyToastExit_420ms_cubic-bezier(0.4,0,0.2,1)_forwards]"
                : "animate-[partyToastEnter_520ms_cubic-bezier(0.16,1,0.3,1)_forwards]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="relative flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent)]/18 text-[var(--accent)]">
                <span className="absolute h-2 w-2 rounded-full bg-[var(--accent)] shadow-accent-dot" />
              </span>

              <span>{displayedPartyEventMessage}</span>
            </div>
          </div>
        </div>
      ) : null}

      {!isViewModeEnabled && isPlaybackInfoOpen ? (
        <PlaybackInfoPanel
          source={sourceWithLiveTranscodingReasons}
          videoError={lastVideoError}
          onClose={() => setIsPlaybackInfoOpen(false)}
        />
      ) : null}

      {error ? (
        <PlayerErrorOverlay
          message={error.message}
          details={error.details}
          canTryTranscoded={hasTranscodingFallback}
          canReturnAuto={hasFileQualities}
          onTryTranscoded={onTryTranscodedPlayback}
          onReturnAuto={handleSelectAutoQuality}
          onRetry={onRetryPlayback}
        />
      ) : null}
    </div>
  );
}
