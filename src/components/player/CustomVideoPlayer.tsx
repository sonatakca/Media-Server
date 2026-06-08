import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
  getTrickplayImageUrl,
  getActiveTranscodingReasons,
  redactPlaybackUrl,
  stopActiveTranscodeSession,
} from "../../lib/jellyfinApi";
import { attachSourceToVideo } from "../../lib/videoSource";
import type { AttachedVideoSource } from "../../lib/videoSource";
import {
  formatTemplate,
  getDisplayTitle,
  getItemSubtitle,
} from "../../lib/format";
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
  STARTUP_WATCHDOG_MS,
  TOUCH_DOUBLE_TAP_THRESHOLD_MS,
  TOUCH_SEEK_SESSION_TIMEOUT_MS,
  TOUCH_SINGLE_TAP_DELAY_MS,
  TRICKPLAY_COLUMNS,
  TRICKPLAY_IMAGES_PER_SHEET,
  TRICKPLAY_INTERVAL_SECONDS,
  TRICKPLAY_RESOLUTION,
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
import { readPortraitPlayerRotation } from "./orientation";
import {
  getPlaybackUrlDebugParams,
  isMasterHlsPlaybackUrl,
  logAudioSourceDebug,
} from "./playbackDebug";
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
  CustomVideoPlayerProps,
  PendingAudioTranscodePlay,
  PendingSourceRestore,
  PortraitPlayerRotation,
  SubtitleCue,
  SubtitleDragState,
  SubtitlePosition,
  SubtitleResizeState,
  SubtitleSize,
  TouchSeekSessionState,
  TouchSeekSide,
} from "./types";
import { useSeekFeedback } from "./useSeekFeedback";

export function CustomVideoPlayer({
  item,
  source,
  playbackCandidates = [],
  notice,
  error,
  hasTranscodingFallback,
  initialStartSeconds = 0,
  onVideoFailure,
  onTryTranscodedPlayback,
  onRetryPlayback,
  onPlaybackStarted,
  onPlaybackProgress,
  onPlaybackStopped,
  onPlaybackBeforeUnload,
  nextEpisode = null,
  playbackQueue = null,
  enableDefaultNextEpisodeCountdown = false,
  onAutoPlayNextEpisode,
  onPlayQueueItem,
}: CustomVideoPlayerProps) {
  const { t } = useLanguage();
  const viewport = useViewportCapabilities();
  const shouldReduceMotion = Boolean(useReducedMotion());
  const [portraitPlayerRotation, setPortraitPlayerRotation] =
    useState<PortraitPlayerRotation>(() => readPortraitPlayerRotation());

  useEffect(() => {
    const updatePortraitPlayerRotation = () => {
      setPortraitPlayerRotation(readPortraitPlayerRotation());
    };
    const screenOrientation = window.screen.orientation;

    updatePortraitPlayerRotation();
    window.addEventListener("orientationchange", updatePortraitPlayerRotation);
    screenOrientation?.addEventListener("change", updatePortraitPlayerRotation);

    return () => {
      window.removeEventListener(
        "orientationchange",
        updatePortraitPlayerRotation,
      );
      screenOrientation?.removeEventListener(
        "change",
        updatePortraitPlayerRotation,
      );
    };
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeAttachmentRef = useRef<AttachedVideoSource | null>(null);
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
  const title = getDisplayTitle(item, mediaFormatLabels);

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

  const progress = usePlayerProgress(videoRef);
  const refreshProgress = progress.refresh;
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
    shouldRenderPlayerChrome || (isViewModeEnabled && isViewModeCursorVisible);

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
  const qualityOptions = useMemo(
    () => getManualQualityOptions(activeSource.mediaSource),
    [activeSource.mediaSource],
  );
  const audioStreams = useMemo(
    () => getStreamsOfType(activeSource, "Audio"),
    [activeSource],
  );
  const canSwitchAudio = Boolean(
    audioStreams.some((stream) => stream.Index !== undefined) &&
    (isDirectBrowserPlaybackSource(activeSource) ||
      activeSource.mediaSource.SupportsTranscoding ||
      activeSource.mode === "Transcoding"),
  );
  const canSwitchSubtitles = Boolean(activeSource.mediaSourceId);

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
        return activeSource;
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
        ...activeSource,
        transcodeReasons: mergedTranscodeReasons,
        mediaSource: {
          ...activeSource.mediaSource,
          TranscodingReasons: mergedTranscodeReasons,
        },
      };
    }, [activeSource, liveTranscodingReasons]);

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
      imageUrl: getTrickplayImageUrl(
        activeSource.itemId,
        activeSource.mediaSourceId,
        TRICKPLAY_RESOLUTION,
        sheetIndex,
      ),
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
  }, [activeSource.id, activeSource.url]);

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
  }, [activeSource.id, activeSource.url]);

  useEffect(() => {
    const defaultAudioIndex = getDefaultAudioStreamIndex(item, source);
    let nextSource = source;

    if (canInjectDefaultAudioIntoStreamCopy(source, defaultAudioIndex)) {
      try {
        nextSource = buildConfiguredHlsPlaybackSource(
          source,
          { audioStreamIndex: defaultAudioIndex },
          "Auto HLS",
          "Built a Jellyfin HLS URL using the file's default audio track.",
        );
      } catch (switchError) {
        console.warn(
          "[Seyirlik Playback] Could not force default audio stream for initial playback",
          switchError,
        );
      }
    }

    pendingSourceRestoreRef.current = null;
    latestPlaybackPositionRef.current = 0;
    hasReportedStoppedRef.current = false;
    hasAutoPlayedNextRef.current = false;
    setActiveSource(nextSource);
    setSelectedQualityId(AUTO_QUALITY_ID);
    setSelectedAudioStreamIndex(defaultAudioIndex);
    setActiveAudioStreamIndex(
      shouldForceDefaultAudioInPlaybackUrl(nextSource) ||
        getStreamsOfType(nextSource, "Audio").length <= 1
        ? defaultAudioIndex
        : undefined,
    );
    setSelectedSubtitleStreamIndex(
      getDefaultSubtitleStreamIndex(item, nextSource),
    );
    setLastVideoError(null);
    setLiveTranscodingReasons([]);
    setCheckpointSeconds(null);
    setIsViewModeCursorVisible(true);
    setIsViewModeEnabled(false);
  }, [item, source.id, source.mediaSourceId, source.url]);
  useEffect(() => {
    let isCancelled = false;
    let intervalId: number | null = null;

    const shouldFetchLiveReasons =
      activeSource.mode === "Transcoding" || activeSource.isHls;

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

      if (currentSource.mode === "Transcoding" || currentSource.isHls) {
        try {
          await stopActiveTranscodeSession(currentSource.playSessionId);
        } catch (stopError) {
          console.warn(
            "[Seyirlik Playback] Could not stop active Jellyfin transcode session",
            stopError,
          );
        }
      }
    },
    [],
  );

  const switchPlayerSource = useCallback(
    async (nextSource: PlaybackSourceCandidate) => {
      const video = videoRef.current;

      if (
        nextSource.id === activeSource.id &&
        nextSource.url === activeSource.url
      ) {
        return;
      }

      sourceSwitchTokenRef.current += 1;

      const currentTime = video?.currentTime ?? progress.currentTime;
      const wasPlaying = video
        ? !video.paused && !video.ended
        : progress.isPlaying;

      pendingSourceRestoreRef.current = {
        token: sourceSwitchTokenRef.current,
        currentTime,
        wasPlaying,
      };
      pendingAudioTranscodePlayRef.current = null;
      clearAudioTranscodeReadinessTimer();
      setIsWaitingForAudioTranscodeReady(false);

      setLastVideoError(null);
      revealPlayerChrome();

      await stopCurrentPlaybackForSourceSwitch(activeSource);

      const cacheBustedUrl = (() => {
        try {
          const url = new URL(nextSource.url);
          url.searchParams.set(
            "seyirlikRestart",
            `${Date.now()}-${sourceSwitchTokenRef.current}`,
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
      revealPlayerChrome,
      stopCurrentPlaybackForSourceSwitch,
    ],
  );

  const buildConfiguredSource = useCallback(
    (
      baseSource: PlaybackSourceCandidate,
      quality?: PlaybackQualityOption,
      audioStreamIndex = selectedAudioStreamIndex,
    ) => {
      const settings: PlaybackSourceSettings = {
        ...getQualitySettings(quality),
        audioStreamIndex,
      };

      return buildConfiguredHlsPlaybackSource(
        baseSource,
        settings,
        quality ? `${quality.label} HLS` : "Auto HLS",
        quality
          ? `Built a Jellyfin HLS URL capped at ${quality.label}.`
          : "Built a Jellyfin HLS URL for the selected audio track.",
      );
    },
    [selectedAudioStreamIndex],
  );

  const handleSelectAutoQuality = useCallback(() => {
    const bestSource = availablePlaybackCandidates[0] ?? source;
    const defaultAudioIndex = getDefaultAudioStreamIndex(item, bestSource);
    let nextSource = bestSource;

    if (canInjectDefaultAudioIntoStreamCopy(bestSource, defaultAudioIndex)) {
      try {
        nextSource = buildConfiguredSource(
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

    void switchPlayerSource(nextSource).catch((switchError: unknown) => {
      console.warn(
        "[Seyirlik Playback] Could not return to Auto quality with default audio",
        switchError,
      );
      void switchPlayerSource(bestSource);
    });
  }, [
    availablePlaybackCandidates,
    buildConfiguredSource,
    item,
    source,
    switchPlayerSource,
  ]);

  const handleSelectQuality = useCallback(
    (quality: PlaybackQualityOption) => {
      let nextSource: PlaybackSourceCandidate;

      try {
        nextSource = buildConfiguredSource(activeSource, quality);
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

  const handleSelectAudioStream = useCallback(
    (streamIndex: number) => {
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
        nextSource = buildConfiguredSource(
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
  }, [hideFullscreenSeekPreviewAfterPaint]);

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
    const selectedAudioIndexForSource =
      selectedAudioStreamIndex ??
      getDefaultAudioStreamIndex(item, sourceToAttach);

    if (!video) {
      return undefined;
    }

    hasStartedRef.current = false;
    lastProgressReportRef.current = 0;

    let attachment: AttachedVideoSource | undefined;
    let didRestore = false;
    let didRequestAudioFallback = false;
    let isDisposed = false;
    const pendingRestore = pendingSourceRestoreRef.current;
    const selectedQuality = qualityOptions.find(
      (quality) => quality.id === selectedQualityId,
    );

    const applyInitialStartPosition = () => {
      if (pendingRestore || hasAppliedInitialStartRef.current) {
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
      if (!isAudioTranscodeSource(sourceToAttach)) {
        if (wasPlaying) {
          void video.play().catch((playError: unknown) => {
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
        existingPending.reason === reason
          ? { ...existingPending, wasPlaying }
          : {
              token,
              reason,
              wasPlaying,
              startedAt: Date.now(),
            };
      setIsWaitingForAudioTranscodeReady(wasPlaying);

      const tryStart = () => {
        const pending = pendingAudioTranscodePlayRef.current;

        if (
          isDisposed ||
          !pending ||
          pending.token !== token ||
          pending.token !== sourceSwitchTokenRef.current
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

      if (!pending || pending.token !== sourceSwitchTokenRef.current) {
        return;
      }

      requestPlayWhenAudioTranscodeReady(pending.reason, pending.wasPlaying);
    };

    let wasPlayingBeforeAudioTranscodeSeek = false;

    const handleAudioTranscodeSeeking = () => {
      if (!isAudioTranscodeSource(sourceToAttach)) {
        return;
      }

      wasPlayingBeforeAudioTranscodeSeek = !video.paused && !video.ended;

      if (wasPlayingBeforeAudioTranscodeSeek) {
        video.pause();
      }

      pendingAudioTranscodePlayRef.current = {
        token: sourceSwitchTokenRef.current,
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
      if (!isAudioTranscodeSource(sourceToAttach)) {
        return;
      }

      requestPlayWhenAudioTranscodeReady(
        "seeked-audio-transcode-buffering",
        wasPlayingBeforeAudioTranscodeSeek,
      );
    };

    const restorePlayback = () => {
      if (
        !pendingRestore ||
        didRestore ||
        pendingRestore.token !== sourceSwitchTokenRef.current
      ) {
        return;
      }

      didRestore = true;

      try {
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

    const requestHlsAudioFallback = (reason: string) => {
      const fallbackBaseSource = getAudioFallbackSource(
        sourceToAttach,
        availablePlaybackCandidates,
      );

      if (
        didRequestAudioFallback ||
        isDisposed ||
        selectedAudioIndexForSource === undefined ||
        !fallbackBaseSource
      ) {
        return;
      }

      didRequestAudioFallback = true;

      let fallbackSource: PlaybackSourceCandidate;

      try {
        fallbackSource = buildConfiguredSource(
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
      if (isDisposed || didRequestAudioFallback) {
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

    const clearStartupWatchdog = () => {
      if (startupWatchdogTimer === null) {
        return;
      }

      window.clearTimeout(startupWatchdogTimer);
      startupWatchdogTimer = null;
    };

    const markStartupPlaybackSignal = () => {
      if (
        isAudioTranscodeSource(sourceToAttach) &&
        !isVideoReadyForAudioTranscodePlayback(video)
      ) {
        return;
      }

      hasStartupPlaybackSignal = true;
      clearStartupWatchdog();
    };

    const handleStartupTimeUpdate = () => {
      if (video.currentTime > 0) {
        markStartupPlaybackSignal();
      }
    };

    const handleStartupError = () => {
      clearStartupWatchdog();
    };

    const startStartupWatchdog = () => {
      clearStartupWatchdog();

      startupWatchdogTimer = window.setTimeout(() => {
        if (isDisposed || hasStartupPlaybackSignal || video.currentTime > 0) {
          return;
        }

        if (
          isAudioTranscodeSource(sourceToAttach) &&
          pendingAudioTranscodePlayRef.current
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

        const detailsPayload = {
          message:
            "HLS attached but playback did not start within startup watchdog timeout.",
          source: {
            mode: sourceToAttach.mode,
            isHls: sourceToAttach.isHls,
            hlsKind: sourceToAttach.hlsKind,
            usingHlsJs: attachment?.usingHlsJs ?? sourceToAttach.usingHlsJs,
            url: redactPlaybackUrl(sourceToAttach.url),
            urlParams: getPlaybackUrlDebugParams(sourceToAttach.url),
          },
          video: {
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            currentTime: video.currentTime,
            duration: Number.isFinite(video.duration) ? video.duration : null,
          },
        };
        const details = JSON.stringify(detailsPayload, null, 2);

        console.warn(
          "[Seyirlik Playback] Startup watchdog detected stalled playback",
          detailsPayload,
        );
        setLastVideoError(details);
        onVideoFailure(details);
      }, STARTUP_WATCHDOG_MS);
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

      attachment = attachSourceToVideo(
        video,
        sourceToAttach.url,
        sourceToAttach.mimeType,
      );
      activeAttachmentRef.current = attachment;

      setActiveSource((currentSource) =>
        currentSource.id === sourceToAttach.id &&
        currentSource.url === sourceToAttach.url
          ? { ...currentSource, usingHlsJs: attachment?.usingHlsJs }
          : currentSource,
      );
      console.info("[Seyirlik Playback] Attached playback source", {
        mode: sourceToAttach.mode,
        isHls: sourceToAttach.isHls,
        hlsKind: sourceToAttach.hlsKind,
        usingHlsJs: attachment?.usingHlsJs,
        url: redactPlaybackUrl(sourceToAttach.url),
        urlParams: sourceUrlParams,
      });
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
      video.addEventListener("loadeddata", markStartupPlaybackSignal);
      video.addEventListener("canplay", markStartupPlaybackSignal);
      video.addEventListener("playing", markStartupPlaybackSignal);
      video.addEventListener("timeupdate", handleStartupTimeUpdate);
      video.addEventListener("error", handleStartupError);
      syncNativeAudioTrack("source-attached");
      video.load();
      startStartupWatchdog();
      if (!pendingRestore && !partyWatch.shouldDeferAutoplay) {
        requestPlayWhenAudioTranscodeReady("initial-autoplay", true);
      }
    } catch (attachError) {
      onVideoFailure(
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
      video.removeEventListener("loadeddata", markStartupPlaybackSignal);
      video.removeEventListener("canplay", markStartupPlaybackSignal);
      video.removeEventListener("playing", markStartupPlaybackSignal);
      video.removeEventListener("timeupdate", handleStartupTimeUpdate);
      video.removeEventListener("error", handleStartupError);

      if (activeAttachmentRef.current === attachment) {
        activeAttachmentRef.current = null;
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
    initialStartSeconds,
    item,
    onVideoFailure,
    partyWatch.shouldDeferAutoplay,
    refreshProgress,
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
    };

    window.addEventListener("pagehide", handlePageExit);
    window.addEventListener("beforeunload", handlePageExit);

    return () => {
      window.removeEventListener("pagehide", handlePageExit);
      window.removeEventListener("beforeunload", handlePageExit);
    };
  }, [reportStoppedOnce]);

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
      activeSource,
      "Subtitle",
      selectedSubtitleStreamIndex,
    );

    if (!subtitleStream) {
      return undefined;
    }

    const abortController = new AbortController();
    const subtitleUrl = buildSubtitleStreamUrl(
      activeSource.itemId,
      activeSource.mediaSourceId,
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
  }, [subtitleCues, subtitleDelaySeconds]);

  const handleVideoPlay = () => {
    if (!hasStartedRef.current) {
      hasStartedRef.current = true;
      onPlaybackStarted?.(videoRef.current?.currentTime ?? 0);
    }
  };

  const handleVideoPause = () => {
    reportPlaybackProgressCheckpoint(true, true);
  };

  const handleVideoSeeked = () => {
    reportPlaybackProgressCheckpoint(videoRef.current?.paused ?? false, true);
  };

  const handleTimeUpdate = () => {
    reportPlaybackProgressCheckpoint(false);
  };

  const handleVideoError = () => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const details = getVideoErrorDetails(video, activeSource);
    setLastVideoError(details);
    console.error("[Seyirlik Playback] video element error", details);
    onVideoFailure(details);
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
    // The video seek uses only this tap's delta; feedback state accumulates
    // separately, while this ref keeps the session's direction/total current.
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
        return true;
      }

      resetTouchSeekSession();
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
      return true;
    }

    resetTouchSeekSession();
    touchSeekSessionRef.current.lastTapTime = now;
    touchSeekSessionRef.current.lastTapSide = tappedSide;

    singleTapTimerRef.current = window.setTimeout(() => {
      if (isViewModeEnabled) {
        partyWatch.togglePlay();
        singleTapTimerRef.current = null;
        return;
      }

      if (
        areControlsVisible ||
        controlsShouldStayVisible ||
        !progress.isPlaying
      ) {
        releaseControlsHover();
      } else {
        showControls();
      }

      singleTapTimerRef.current = null;
    }, TOUCH_SINGLE_TAP_DELAY_MS);

    return false;
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
  const playerEpisodeName = isEpisodeItem ? item.Name.trim() || null : null;
  const playerSeriesLogoItemId = isEpisodeItem
    ? (item.ParentLogoItemId ?? item.SeriesId ?? null)
    : null;
  const titleLogoUrl =
    playerSeriesLogoItemId && item.ParentLogoImageTag
      ? getLogoImageUrl(playerSeriesLogoItemId, item.ParentLogoImageTag, 900)
      : item.ImageTags?.Logo
        ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 900)
        : "";
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
    Math.min(viewport.width, viewport.height) <= 520 &&
    Math.max(viewport.width, viewport.height) <= 980;
  const shouldRotatePortraitPlayer =
    viewport.isPortrait && isCompactPhonePlayer;
  const seekPointerAxis = shouldRotatePortraitPlayer
    ? portraitPlayerRotation === 90
      ? "vertical-forward"
      : "vertical-reverse"
    : "horizontal";
  const portraitPlayerStyle = shouldRotatePortraitPlayer
    ? ({
        "--seyirlik-player-rotation": `${portraitPlayerRotation}deg`,
      } as CSSProperties)
    : undefined;

  return (
    <div
      ref={containerRef}
      className={`seyirlik-player-shell select-none ${
        shouldRotatePortraitPlayer
          ? "seyirlik-player-shell--rotated-portrait"
          : "fixed inset-0"
      } ${isCompactPhonePlayer ? "seyirlik-player-shell--phone" : ""} z-50 min-h-0 overflow-hidden bg-black text-white ${
        shouldShowPlayerCursor ? "cursor-default" : "cursor-none"
      }`}
      style={portraitPlayerStyle}
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
      <video
        ref={videoRef}
        controls={false}
        playsInline
        preload="auto"
        className="seyirlik-video h-full w-full bg-black object-contain"
        onPlay={handleVideoPlay}
        onPause={handleVideoPause}
        onTimeUpdate={handleTimeUpdate}
        onSeeked={handleVideoSeeked}
        onWaiting={revealPlayerChrome}
        onError={handleVideoError}
        onEnded={() => {
          const positionSeconds = updateLatestPlaybackPosition();
          onPlaybackProgress?.(positionSeconds, true);
          reportStoppedOnce(false);
          handleDefaultNextEpisodePlay();
        }}
      />

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
            backTo={`/item/${item.Id}`}
            visible={shouldRenderPlayerChrome}
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
                      className="relative flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.12] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
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
                      className="relative flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.12] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
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
                      className={`relative flex h-11 w-11 items-center justify-center rounded-full transition-colors duration-300 ease focus:outline-none focus:ring-2 focus:ring-[var(--accent)] ${
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
          onTryTranscoded={onTryTranscodedPlayback}
          onRetry={onRetryPlayback}
        />
      ) : null}
    </div>
  );
}
