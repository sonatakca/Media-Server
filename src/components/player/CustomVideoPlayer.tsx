import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Loader2, RotateCcw, Smartphone, Users } from "lucide-react";
import {
  buildConfiguredHlsPlaybackSource,
  buildSubtitleStreamUrl,
  getLogoImageUrl,
  getManualQualityOptions,
  getTrickplayImageUrl,
  stopActiveTranscodeSession,
} from "../../lib/jellyfinApi";
import { attachSourceToVideo } from "../../lib/videoSource";
import type { AttachedVideoSource } from "../../lib/videoSource";
import { getDisplayTitle, getItemSubtitle } from "../../lib/format";
import { getVideoErrorDetails, type PlaybackTechnicalDetails } from "../../hooks/usePlaybackSource";
import { useAutoHideControls } from "../../hooks/useAutoHideControls";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { usePlayerProgress } from "../../hooks/usePlayerProgress";
import { useViewportCapabilities } from "../../hooks/useViewportCapabilities";
import { useLanguage } from "../../i18n/LanguageContext";
import type {
  JellyfinItem,
  JellyfinMediaStream,
  PlaybackQualityOption,
  PlaybackSourceCandidate,
  PlaybackSourceSettings,
} from "../../lib/types";
import { PlayerControls } from "./PlayerControls";
import { PlayerErrorOverlay } from "./PlayerErrorOverlay";
import { PlayerOverlay } from "./PlayerOverlay";
import { PlaybackInfoButton } from "./PlaybackInfoButton";
import { PlaybackInfoPanel } from "./PlaybackInfoPanel";
import { PartyWatchControls } from "../../features/partyWatch/PartyWatchControls";
import { PartyWatchOverlay } from "../../features/partyWatch/PartyWatchOverlay";
import { usePartyWatchController } from "../../features/partyWatch/usePartyWatchController";

interface CustomVideoPlayerProps {
  item: JellyfinItem;
  source: PlaybackSourceCandidate;
  playbackCandidates?: PlaybackSourceCandidate[];
  notice?: string | null;
  error?: PlaybackTechnicalDetails | null;
  hasTranscodingFallback: boolean;
  onVideoFailure: (details: string) => void;
  onTryTranscodedPlayback: () => void;
  onRetryPlayback: () => void;
  onPlaybackStarted?: (positionSeconds: number) => void;
  onPlaybackProgress?: (positionSeconds: number, isPaused: boolean) => void;
  onPlaybackStopped?: (positionSeconds: number) => void;
}

interface PendingSourceRestore {
  token: number;
  currentTime: number;
  wasPlaying: boolean;
}

interface SubtitlePosition {
  x: number;
  y: number;
}

interface SubtitleDragState {
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

interface SubtitleSize {
  scale: number;
}

type SeekFeedbackDirection = "backward" | "forward";

interface SeekFeedbackItem {
  amount: number;
  visible: boolean;
  rotation: number;
  pulse: number;
}

interface SeekFeedbackState {
  backward: SeekFeedbackItem;
  forward: SeekFeedbackItem;
}

interface SubtitleResizeState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScale: number;
  directionX: -1 | 1;
  directionY: -1 | 1;
}

const AUTO_QUALITY_ID = "auto";
const DEFAULT_SUBTITLE_SCALE = 1;
const MIN_SUBTITLE_SCALE = 0.7;
const MAX_SUBTITLE_SCALE = 2.4;

const TRICKPLAY_RESOLUTION = 320;
const TRICKPLAY_INTERVAL_SECONDS = 10;
const TRICKPLAY_COLUMNS = 10;
const TRICKPLAY_ROWS = 10;
const TRICKPLAY_IMAGES_PER_SHEET = TRICKPLAY_COLUMNS * TRICKPLAY_ROWS;
const TRICKPLAY_TILE_WIDTH = 320;
const TRICKPLAY_TILE_HEIGHT = 132;

const SEEK_FEEDBACK_OPPOSITE_HIDE_MS = 100;

const SEEK_FEEDBACK_HIDE_MS = 950;

const SEEK_FEEDBACK_FADE_RESET_MS = 260;

const initialSeekFeedback: SeekFeedbackState = {
  backward: {
    amount: 0,
    visible: false,
    rotation: 0,
    pulse: 0,
  },
  forward: {
    amount: 0,
    visible: false,
    rotation: 0,
    pulse: 0,
  },
};

function getStreamsOfType(source: PlaybackSourceCandidate, type: "Audio" | "Subtitle"): JellyfinMediaStream[] {
  return source.mediaSource.MediaStreams?.filter((stream) => stream.Type?.toLowerCase() === type.toLowerCase()) ?? [];
}

function getDefaultAudioStreamIndex(source: PlaybackSourceCandidate): number | undefined {
  return source.mediaSource.DefaultAudioStreamIndex ?? getStreamsOfType(source, "Audio")[0]?.Index;
}

function getDefaultSubtitleStreamIndex(source: PlaybackSourceCandidate): number {
  return source.mediaSource.DefaultSubtitleStreamIndex ?? -1;
}

function getStreamByIndex(
  source: PlaybackSourceCandidate,
  type: "Audio" | "Subtitle",
  streamIndex: number,
): JellyfinMediaStream | undefined {
  return getStreamsOfType(source, type).find((stream) => stream.Index === streamIndex);
}

function getSubtitleTrackLabel(stream: JellyfinMediaStream): string {
  return (
    [stream.DisplayTitle, stream.Title, stream.Language?.toUpperCase(), stream.Codec?.toUpperCase()]
      .filter(Boolean)
      .join(" · ") || `Subtitle ${stream.Index ?? ""}`.trim()
  );
}

function getQualitySettings(quality?: PlaybackQualityOption): PlaybackSourceSettings {
  if (!quality) {
    return {};
  }

  return {
    maxHeight: quality.maxHeight,
    maxWidth: quality.maxWidth,
    maxStreamingBitrate: quality.maxStreamingBitrate,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getCueText(cue: TextTrackCue): string {
  const maybeTextCue = cue as TextTrackCue & { text?: unknown };
  return typeof maybeTextCue.text === "string" ? maybeTextCue.text : "";
}

function decodeCueText(rawText: string): string {
  const textWithLineBreaks = rawText
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(b|i|u|c|lang|ruby|rt)[^>]*>/gi, "")
    .replace(/<\/?v[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");

  const textarea = document.createElement("textarea");
  textarea.innerHTML = textWithLineBreaks;
  return textarea.value.trim();
}

export function CustomVideoPlayer({
  item,
  source,
  playbackCandidates = [],
  notice,
  error,
  hasTranscodingFallback,
  onVideoFailure,
  onTryTranscodedPlayback,
  onRetryPlayback,
  onPlaybackStarted,
  onPlaybackProgress,
  onPlaybackStopped,
}: CustomVideoPlayerProps) {
  const { t } = useLanguage();
  const viewport = useViewportCapabilities();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeAttachmentRef = useRef<AttachedVideoSource | null>(null);
  const lastTapRef = useRef<{ time: number; x: number } | null>(null);
  const lastProgressReportRef = useRef(0);
  const hasStartedRef = useRef(false);
  const sourceSwitchTokenRef = useRef(0);
  const pendingSourceRestoreRef = useRef<PendingSourceRestore | null>(null);
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
  const seekFeedbackHideTimersRef = useRef<Record<SeekFeedbackDirection, number | null>>({
    backward: null,
    forward: null,
  });
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
  const [isPartyWatchOpen, setIsPartyWatchOpen] = useState(false);
  const [isSubtitleEditMode, setIsSubtitleEditMode] = useState(false);

  const progress = usePlayerProgress(videoRef);
  const refreshProgress = progress.refresh;

  const controlsShouldStayVisible =
    isSettingsOpen ||
    isPlaybackInfoOpen ||
    isPartyWatchOpen ||
    isSubtitleEditMode;

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

  const partyWatch = usePartyWatchController({
    videoRef,
    itemId: item.Id,
    title,
    currentTime: progress.currentTime,
    isPlaying: progress.isPlaying,
    refreshProgress,
    showControls,
  });

  const [displayedPartyEventMessage, setDisplayedPartyEventMessage] = useState<string | null>(null);
  const [isPartyEventToastLeaving, setIsPartyEventToastLeaving] = useState(false);
  const [fullscreenSeekPreviewSeconds, setFullscreenSeekPreviewSeconds] = useState<number | null>(null);
  const [seekFeedback, setSeekFeedback] = useState<SeekFeedbackState>(initialSeekFeedback);

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

  const [activeSource, setActiveSource] = useState<PlaybackSourceCandidate>(source);
  const [selectedQualityId, setSelectedQualityId] = useState(AUTO_QUALITY_ID);
  const [selectedAudioStreamIndex, setSelectedAudioStreamIndex] = useState<number | undefined>(() =>
    getDefaultAudioStreamIndex(source),
  );
  const [selectedSubtitleStreamIndex, setSelectedSubtitleStreamIndex] = useState<number>(() =>
    getDefaultSubtitleStreamIndex(source),
  );
  const [lastVideoError, setLastVideoError] = useState<string | null>(null);
  const [activeSubtitleText, setActiveSubtitleText] = useState("");
  const [subtitlePosition, setSubtitlePosition] = useState<SubtitlePosition | null>(null);
  const [subtitleSize, setSubtitleSize] = useState<SubtitleSize>({ scale: DEFAULT_SUBTITLE_SCALE });
  const [isDraggingSubtitle, setIsDraggingSubtitle] = useState(false);
  const [isResizingSubtitle, setIsResizingSubtitle] = useState(false);
  const availablePlaybackCandidates = playbackCandidates.length > 0 ? playbackCandidates : [source];
  const qualityOptions = useMemo(() => getManualQualityOptions(activeSource.mediaSource), [activeSource.mediaSource]);
  const canSwitchAudio = Boolean(
    activeSource.mediaSource.Id && (activeSource.mediaSource.SupportsTranscoding || activeSource.mode === "Transcoding"),
  );
  const canSwitchSubtitles = Boolean(activeSource.mediaSourceId);
  
  const fullscreenSeekPreview = useMemo(() => {
    if (fullscreenSeekPreviewSeconds === null || !activeSource.mediaSourceId || progress.duration <= 0) {
      return null;
    }

    const globalTileIndex = Math.max(0, Math.floor(fullscreenSeekPreviewSeconds / TRICKPLAY_INTERVAL_SECONDS));
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
  }, [activeSource.itemId, activeSource.mediaSourceId, fullscreenSeekPreviewSeconds, progress.duration]);

  const fullscreenSeekPreviewRect = useMemo(() => {
  const video = videoRef.current;
  const container = containerRef.current;

  if (!video || !container) {
    return null;
  }

  const containerBounds = container.getBoundingClientRect();
  const videoAspect =
    video.videoWidth > 0 && video.videoHeight > 0
      ? video.videoWidth / video.videoHeight
      : TRICKPLAY_TILE_WIDTH / TRICKPLAY_TILE_HEIGHT;

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
}, [fullscreenSeekPreviewSeconds, progress.duration]);
  

  useEffect(() => {
    pendingSourceRestoreRef.current = null;
    setActiveSource(source);
    setSelectedQualityId(AUTO_QUALITY_ID);
    setSelectedAudioStreamIndex(getDefaultAudioStreamIndex(source));
    setSelectedSubtitleStreamIndex(getDefaultSubtitleStreamIndex(source));
    setLastVideoError(null);
  }, [source.id, source.mediaSourceId, source.url]);

  useEffect(() => {
    setActiveSubtitleText("");
    setSubtitlePosition(null);
    setSubtitleSize({ scale: DEFAULT_SUBTITLE_SCALE });
    setIsDraggingSubtitle(false);
    setIsResizingSubtitle(false);
    setIsSubtitleEditMode(false);
    subtitleDragStateRef.current = null;
    subtitleResizeStateRef.current = null;
    suppressPlayerTapUntilRef.current = 0;
  }, [item.Id]);

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

  const clearSeekFeedbackTimers = useCallback(() => {
    (["backward", "forward"] as const).forEach((direction) => {
      if (seekFeedbackHideTimersRef.current[direction] !== null) {
        window.clearTimeout(seekFeedbackHideTimersRef.current[direction]!);
        seekFeedbackHideTimersRef.current[direction] = null;
      }
    });
  }, []);

  const triggerSeekFeedback = useCallback((seconds: number) => {
    if (seconds === 0) {
      return;
    }

    const direction: SeekFeedbackDirection = seconds < 0 ? "backward" : "forward";
    const oppositeDirection: SeekFeedbackDirection = direction === "backward" ? "forward" : "backward";
    const amount = Math.abs(seconds);

    if (seekFeedbackHideTimersRef.current[oppositeDirection] !== null) {
      window.clearTimeout(seekFeedbackHideTimersRef.current[oppositeDirection]!);
    }

    seekFeedbackHideTimersRef.current[oppositeDirection] = window.setTimeout(() => {
      setSeekFeedback((current) => ({
        ...current,
        [oppositeDirection]: {
          ...current[oppositeDirection],
          visible: false,
        },
      }));

      window.setTimeout(() => {
        setSeekFeedback((current) => {
          if (current[oppositeDirection].visible) {
            return current;
          }

          return {
            ...current,
            [oppositeDirection]: {
              ...current[oppositeDirection],
              amount: 0,
            },
          };
        });
      }, SEEK_FEEDBACK_FADE_RESET_MS);

      seekFeedbackHideTimersRef.current[oppositeDirection] = null;
    }, SEEK_FEEDBACK_OPPOSITE_HIDE_MS);

    setSeekFeedback((current) => {
      const currentDirection = current[direction];

      return {
        ...current,
        [direction]: {
          ...currentDirection,
          amount: currentDirection.amount + amount,
          visible: true,
          rotation: currentDirection.rotation + (direction === "forward" ? 360 : -360),
          pulse: currentDirection.pulse + 1,
        },
      };
    });

    if (seekFeedbackHideTimersRef.current[direction] !== null) {
      window.clearTimeout(seekFeedbackHideTimersRef.current[direction]!);
    }

    seekFeedbackHideTimersRef.current[direction] = window.setTimeout(() => {
      setSeekFeedback((current) => ({
        ...current,
        [direction]: {
          ...current[direction],
          visible: false,
        },
      }));

      window.setTimeout(() => {
        setSeekFeedback((current) => {
          if (current[direction].visible) {
            return current;
          }

          return {
            ...current,
            [direction]: {
              ...current[direction],
              amount: 0,
            },
          };
        });
      }, SEEK_FEEDBACK_FADE_RESET_MS);

      seekFeedbackHideTimersRef.current[direction] = null;
    }, SEEK_FEEDBACK_HIDE_MS);
  }, []);

  const handleSeekBy = useCallback(
    (seconds: number) => {
      partyWatch.seekBy(seconds);
      triggerSeekFeedback(seconds);
      showControls();
    },
    [partyWatch, showControls, triggerSeekFeedback],
  );

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
    if (!isPartyWatchOpen) {
      return undefined;
    }

    const handlePointerDownOutsidePartyWatch = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement | null;

      if (target?.closest("[data-party-watch-root]")) {
        return;
      }

      setIsPartyWatchOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDownOutsidePartyWatch);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDownOutsidePartyWatch);
    };
  }, [isPartyWatchOpen]);

  useEffect(() => {
    if (!isSubtitleEditMode) {
      return undefined;
    }

    const handlePointerDownOutsideSubtitle = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement | null;

      if (
        target?.closest("[data-subtitle-editor-root]") ||
        target?.closest("[data-player-settings-root]")
      ) {
        return;
      }

      setIsSubtitleEditMode(false);
      setIsDraggingSubtitle(false);
      setIsResizingSubtitle(false);
      subtitleDragStateRef.current = null;
      subtitleResizeStateRef.current = null;
      suppressPlayerTapUntilRef.current = Date.now() + 350;
    };

    document.addEventListener("pointerdown", handlePointerDownOutsideSubtitle);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDownOutsideSubtitle);
    };
  }, [isSubtitleEditMode]);

  const stopCurrentPlaybackForSourceSwitch = useCallback(async (currentSource: PlaybackSourceCandidate) => {
    const video = videoRef.current;

    try {
      video?.pause();
    } catch {
      // Ignore pause errors during source switching.
    }

    try {
      activeAttachmentRef.current?.destroy();
    } catch (destroyError) {
      console.warn("[Seyirlik Playback] Could not destroy current video attachment before source switch", destroyError);
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
        console.warn("[Seyirlik Playback] Could not stop active Jellyfin transcode session", stopError);
      }
    }
  }, []);

  const switchPlayerSource = useCallback(
    async (nextSource: PlaybackSourceCandidate) => {
      const video = videoRef.current;

      if (nextSource.id === activeSource.id && nextSource.url === activeSource.url) {
        return;
      }

      sourceSwitchTokenRef.current += 1;

      const currentTime = video?.currentTime ?? progress.currentTime;
      const wasPlaying = video ? !video.paused && !video.ended : progress.isPlaying;

      pendingSourceRestoreRef.current = {
        token: sourceSwitchTokenRef.current,
        currentTime,
        wasPlaying,
      };

      setLastVideoError(null);
      showControls();

      await stopCurrentPlaybackForSourceSwitch(activeSource);

      const cacheBustedUrl = (() => {
        try {
          const url = new URL(nextSource.url);
          url.searchParams.set("seyirlikRestart", `${Date.now()}-${sourceSwitchTokenRef.current}`);
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
      progress.currentTime,
      progress.isPlaying,
      showControls,
      stopCurrentPlaybackForSourceSwitch,
    ],
  );

  const buildConfiguredSource = useCallback(
    (baseSource: PlaybackSourceCandidate, quality?: PlaybackQualityOption, audioStreamIndex = selectedAudioStreamIndex) => {
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
    const defaultAudioIndex = getDefaultAudioStreamIndex(bestSource);
    const shouldKeepAudioOverride =
      selectedAudioStreamIndex !== undefined && selectedAudioStreamIndex !== defaultAudioIndex;

    setSelectedQualityId(AUTO_QUALITY_ID);

    void switchPlayerSource(
      shouldKeepAudioOverride ? buildConfiguredSource(bestSource, undefined, selectedAudioStreamIndex) : bestSource,
    ).catch((switchError: unknown) => {
      console.warn("[Seyirlik Playback] Could not keep selected audio while returning to Auto quality", switchError);
      setSelectedAudioStreamIndex(defaultAudioIndex);
      void switchPlayerSource(bestSource);
    });
  }, [availablePlaybackCandidates, buildConfiguredSource, selectedAudioStreamIndex, source, switchPlayerSource]);

  const handleSelectQuality = useCallback(
    (quality: PlaybackQualityOption) => {
      let nextSource: PlaybackSourceCandidate;

      try {
        nextSource = buildConfiguredSource(activeSource, quality);
      } catch (switchError) {
        console.warn("[Seyirlik Playback] Could not build quality source", switchError);
        return;
      }

      setSelectedQualityId(quality.id);

      void switchPlayerSource(nextSource).catch((switchError: unknown) => {
        console.warn("[Seyirlik Playback] Could not switch quality", switchError);
      });
    },
    [activeSource, buildConfiguredSource, switchPlayerSource],
  );

  const handleSelectAudioStream = useCallback(
    (streamIndex: number) => {
      if (!canSwitchAudio) {
        return;
      }

      const selectedQuality = qualityOptions.find((quality) => quality.id === selectedQualityId);
      let nextSource: PlaybackSourceCandidate;

      try {
        nextSource = buildConfiguredSource(activeSource, selectedQuality, streamIndex);
      } catch (switchError) {
        console.warn("[Seyirlik Playback] Could not build audio stream source", switchError);
        return;
      }

      setSelectedAudioStreamIndex(streamIndex);

      void switchPlayerSource(nextSource).catch((switchError: unknown) => {
        console.warn("[Seyirlik Playback] Could not switch audio stream", switchError);
      });
    },
    [activeSource, buildConfiguredSource, canSwitchAudio, qualityOptions, selectedQualityId, switchPlayerSource],
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
      showControls();
    },
    [clearFullscreenSeekPreviewFallbackTimer, showControls],
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

      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;

      if (!video.ended && Math.abs(currentTime - pendingPreview.targetSeconds) > 1.5) {
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

  const handleSelectSubtitleStream = useCallback((streamIndex: number) => {
    setActiveSubtitleText("");
    setSelectedSubtitleStreamIndex(streamIndex);
    showControls();
  }, [showControls]);

  useEffect(() => {
    const video = videoRef.current;
    const sourceToAttach = activeSource;

    if (!video) {
      return undefined;
    }

    hasStartedRef.current = false;
    lastProgressReportRef.current = 0;

    let attachment: AttachedVideoSource | undefined;
    let didRestore = false;
    const pendingRestore = pendingSourceRestoreRef.current;

    const restorePlayback = () => {
      if (!pendingRestore || didRestore || pendingRestore.token !== sourceSwitchTokenRef.current) {
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
        console.warn("[Seyirlik Playback] Could not restore playback position after source switch", seekError);
      }

      if (pendingRestore.wasPlaying) {
        void video.play().catch((playError: unknown) => {
          console.info("[Seyirlik Playback] Playback resume was blocked or deferred", playError);
        });
      } else {
        video.pause();
      }

      pendingSourceRestoreRef.current = null;
      refreshProgress();
    };

    try {
      attachment = attachSourceToVideo(video, sourceToAttach.url, sourceToAttach.mimeType);
      activeAttachmentRef.current = attachment;

      setActiveSource((currentSource) =>
        currentSource.id === sourceToAttach.id && currentSource.url === sourceToAttach.url
          ? { ...currentSource, usingHlsJs: attachment?.usingHlsJs }
          : currentSource,
      );
      video.addEventListener("loadedmetadata", restorePlayback);
      video.addEventListener("canplay", restorePlayback);
      video.load();
      if (!pendingRestore && !partyWatch.shouldDeferAutoplay) {
        void video.play().catch((playError: unknown) => {
          console.info("[Seyirlik Playback] Autoplay was blocked or deferred", playError);
        });
      }
    } catch (attachError) {
      onVideoFailure(attachError instanceof Error ? attachError.message : String(attachError));
    }

    return () => {
      video.removeEventListener("loadedmetadata", restorePlayback);
      video.removeEventListener("canplay", restorePlayback);

      if (activeAttachmentRef.current === attachment) {
        activeAttachmentRef.current = null;
      }

      try {
        attachment?.destroy();
      } catch (destroyError) {
        console.warn("[Seyirlik Playback] Could not destroy video attachment during cleanup", destroyError);
      }
    };
  }, [activeSource.id, activeSource.mimeType, activeSource.url, onVideoFailure, partyWatch.shouldDeferAutoplay, refreshProgress]);

  useEffect(() => {
    return () => {
      clearFullscreenSeekPreviewFallbackTimer();
      clearSeekFeedbackTimers();

      if (singleTapTimerRef.current !== null) {
        window.clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }

      if (hasStartedRef.current) {
        onPlaybackStopped?.(videoRef.current?.currentTime ?? 0);
      }
    };
  }, [clearFullscreenSeekPreviewFallbackTimer, clearSeekFeedbackTimers, onPlaybackStopped]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    video.querySelectorAll<HTMLTrackElement>("track[data-seyirlik-subtitle]").forEach((track) => track.remove());

    for (let index = 0; index < video.textTracks.length; index += 1) {
      video.textTracks[index].mode = "disabled";
    }

    setActiveSubtitleText("");

    if (selectedSubtitleStreamIndex < 0 || !activeSource.mediaSourceId) {
      return undefined;
    }

    const subtitleStream = getStreamByIndex(activeSource, "Subtitle", selectedSubtitleStreamIndex);

    if (!subtitleStream) {
      return undefined;
    }

    const trackElement = document.createElement("track");
    trackElement.kind = "subtitles";
    trackElement.label = getSubtitleTrackLabel(subtitleStream);
    trackElement.srclang = subtitleStream.Language || "und";
    trackElement.src = buildSubtitleStreamUrl(
      activeSource.itemId,
      activeSource.mediaSourceId,
      selectedSubtitleStreamIndex,
    );
    trackElement.default = false;
    trackElement.dataset.seyirlikSubtitle = "true";

    const updateActiveSubtitleText = () => {
      const activeCues = trackElement.track.activeCues;
      const cues = activeCues
        ? Array.from({ length: activeCues.length }, (_, index) => activeCues[index])
        : [];

      const decodedCueTexts = cues
        .map(getCueText)
        .map(decodeCueText)
        .filter(Boolean);

      const cueText = decodedCueTexts[decodedCueTexts.length - 1] ?? "";

      setActiveSubtitleText(cueText);
    };

    const handleTrackLoad = () => {
      trackElement.track.mode = "hidden";
      updateActiveSubtitleText();
    };

    trackElement.addEventListener("load", handleTrackLoad);
    video.appendChild(trackElement);
    trackElement.track.mode = "hidden";
    trackElement.track.addEventListener("cuechange", updateActiveSubtitleText);
    updateActiveSubtitleText();

    return () => {
      trackElement.removeEventListener("load", handleTrackLoad);
      trackElement.track.removeEventListener("cuechange", updateActiveSubtitleText);
      trackElement.remove();
    };
  }, [activeSource, selectedSubtitleStreamIndex]);

  const handleVideoPlay = () => {
    if (!hasStartedRef.current) {
      hasStartedRef.current = true;
      onPlaybackStarted?.(videoRef.current?.currentTime ?? 0);
    }
  };

  const handleVideoPause = () => {
    onPlaybackProgress?.(videoRef.current?.currentTime ?? 0, true);
  };

  const handleTimeUpdate = () => {
    const now = Date.now();

    if (now - lastProgressReportRef.current < 15_000) {
      return;
    }

    lastProgressReportRef.current = now;
    onPlaybackProgress?.(videoRef.current?.currentTime ?? 0, false);
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

  const handleDoubleSeek = (clientX: number) => {
    if (Date.now() < suppressPlayerTapUntilRef.current) {
      return;
    }

    const bounds = containerRef.current?.getBoundingClientRect();

    if (!bounds) {
      return;
    }

    const isLeftSide = clientX - bounds.left < bounds.width / 2;
    handleSeekBy(isLeftSide ? -10 : 10);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (isDraggingSubtitle || isResizingSubtitle || Date.now() < suppressPlayerTapUntilRef.current) {
      return;
    }

    const target = event.target as HTMLElement | null;

    const tappedInteractiveElement = target?.closest(
      "button, a, input, [role='slider'], [data-player-settings-root], [data-party-watch-root], [data-subtitle-editor-root]",
    );

    if (tappedInteractiveElement) {
      return;
    }

    if (event.pointerType !== "touch") {
      return;
    }

    const now = Date.now();
    const previousTap = lastTapRef.current;

    if (previousTap && now - previousTap.time < 320 && Math.abs(previousTap.x - event.clientX) < 70) {
      if (singleTapTimerRef.current !== null) {
        window.clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }

      handleDoubleSeek(event.clientX);
      lastTapRef.current = null;
      return;
    }

    lastTapRef.current = { time: now, x: event.clientX };

    singleTapTimerRef.current = window.setTimeout(() => {
      if (areControlsVisible || controlsShouldStayVisible || !progress.isPlaying) {
        releaseControlsHover();
      } else {
        showControls();
      }

      singleTapTimerRef.current = null;
    }, 180);
  };

  const getSubtitlePositionFromPoint = useCallback((clientX: number, clientY: number): SubtitlePosition | null => {
    const bounds = containerRef.current?.getBoundingClientRect();
    const dragState = subtitleDragStateRef.current;

    if (!bounds || !dragState) {
      return null;
    }

    return {
      x: clamp(((clientX - bounds.left - dragState.offsetX) / bounds.width) * 100, 8, 92),
      y: clamp(((clientY - bounds.top - dragState.offsetY) / bounds.height) * 100, 10, 90),
    };
  }, []);

  const handleSubtitleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const bounds = containerRef.current?.getBoundingClientRect();
    const overlayBounds = subtitleOverlayRef.current?.getBoundingClientRect();

    if (bounds && overlayBounds) {
      const overlayCenterX = overlayBounds.left + overlayBounds.width / 2;
      const overlayCenterY = overlayBounds.top + overlayBounds.height / 2;

      setSubtitlePosition((currentPosition) => currentPosition ?? {
        x: clamp(((overlayCenterX - bounds.left) / bounds.width) * 100, 8, 92),
        y: clamp(((overlayCenterY - bounds.top) / bounds.height) * 100, 10, 90),
      });
    }

    setIsSubtitleEditMode(true);
    showControls();
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
    lastTapRef.current = null;
    showControls();
  };

  const handleSubtitleResizePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const resizeState = subtitleResizeStateRef.current;

    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const deltaX = (event.clientX - resizeState.startClientX) * resizeState.directionX;
    const deltaY = (event.clientY - resizeState.startClientY) * resizeState.directionY;
    const strongestDelta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    const nextScale = clamp(resizeState.startScale + strongestDelta / 220, MIN_SUBTITLE_SCALE, MAX_SUBTITLE_SCALE);

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
    lastTapRef.current = null;
  };

  const handleSubtitleResizePointerCancel = (event: PointerEvent<HTMLButtonElement>) => {
    if (subtitleResizeStateRef.current?.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    subtitleResizeStateRef.current = null;
    setIsResizingSubtitle(false);
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    lastTapRef.current = null;
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

    setSubtitlePosition((currentPosition) => currentPosition ?? {
      x: clamp(((overlayCenterX - bounds.left) / bounds.width) * 100, 8, 92),
      y: clamp(((overlayCenterY - bounds.top) / bounds.height) * 100, 10, 90),
    });
    setIsDraggingSubtitle(true);
    setIsResizingSubtitle(false);
    subtitleResizeStateRef.current = null;
    lastTapRef.current = null;
    showControls();
  };

  const handleSubtitlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = subtitleDragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const nextPosition = getSubtitlePositionFromPoint(event.clientX, event.clientY);

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

    const nextPosition = getSubtitlePositionFromPoint(event.clientX, event.clientY);

    if (nextPosition) {
      setSubtitlePosition(nextPosition);
    }

    subtitleDragStateRef.current = null;
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    setIsDraggingSubtitle(false);
    lastTapRef.current = null;
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
    lastTapRef.current = null;
  };

  const subtitle = getItemSubtitle(item, mediaFormatLabels);
  const titleLogoUrl = item.ImageTags?.Logo ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 900) : "";
  const isSubtitleBeingEdited = isDraggingSubtitle || isResizingSubtitle || isSubtitleEditMode;
  const isShowingSubtitlePlaceholder = isSubtitleBeingEdited && activeSubtitleText.trim().length === 0;

  const subtitleLines = (isShowingSubtitlePlaceholder ? t("player.subtitleEditPlaceholder") : activeSubtitleText)
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

  return (
    <div
      ref={containerRef}
      className="seyirlik-player-shell relative h-[100svh] min-h-0 overflow-hidden bg-black text-white lg:min-h-[32rem]"
      onMouseMove={showControls}
      onPointerDown={showControls}
      onPointerUp={handlePointerUp}
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
        onWaiting={showControls}
        onError={handleVideoError}
        onEnded={() => {
          onPlaybackProgress?.(videoRef.current?.currentTime ?? 0, true);
          onPlaybackStopped?.(videoRef.current?.currentTime ?? 0);
        }}
      />

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
              className="origin-top-left opacity-95"
              style={{
                width: `${TRICKPLAY_TILE_WIDTH}px`,
                height: `${TRICKPLAY_TILE_HEIGHT}px`,
                transform: `scale(${fullscreenSeekPreviewRect.width / TRICKPLAY_TILE_WIDTH}, ${
                  fullscreenSeekPreviewRect.height / TRICKPLAY_TILE_HEIGHT
                })`,
                backgroundImage: `url("${fullscreenSeekPreview.imageUrl}")`,
                backgroundSize: `${TRICKPLAY_TILE_WIDTH * TRICKPLAY_COLUMNS}px ${
                  TRICKPLAY_TILE_HEIGHT * TRICKPLAY_ROWS
                }px`,
                backgroundPosition: `-${fullscreenSeekPreview.column * TRICKPLAY_TILE_WIDTH}px -${
                  fullscreenSeekPreview.row * TRICKPLAY_TILE_HEIGHT
                }px`,
                backgroundRepeat: "no-repeat",
              }}
            />

            <div className="absolute inset-0 bg-black/22" />

          </div>
        </div>
      ) : null}

      {viewport.isPhoneViewport && viewport.isPortrait ? (
        <div className="pointer-events-none absolute inset-0 z-[65] flex items-center justify-center bg-[rgba(5,6,7,0.82)] px-6 text-center backdrop-blur-xl">
          <div className="max-w-sm rounded-2xl border border-white/10 bg-[var(--surface)] p-5 shadow-[0_24px_110px_rgba(0,0,0,0.62)]">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-[var(--accent)]/35 bg-[var(--accent-soft)] text-[var(--accent)]">
              <div className="relative">
                <Smartphone size={30} />
                <RotateCcw className="absolute -right-5 -top-4 animate-[spin_4s_linear_infinite] text-[var(--accent-hover)] motion-reduce:animate-none" size={19} />
              </div>
            </div>
            <h2 className="mt-4 text-xl font-black text-white">{t("player.rotateTitle")}</h2>
            <p className="mt-2 text-sm font-semibold leading-6 text-white/72">{t("player.rotateMessage")}</p>
            <p className="mt-3 text-xs font-medium text-white/45">{t("player.rotateHint")}</p>
          </div>
        </div>
      ) : null}

      {subtitleLines.length > 0 ? (
        <div
          ref={subtitleOverlayRef}
          data-subtitle-editor-root
          className={`seyirlik-subtitle-overlay absolute z-[24] ${
            subtitlePosition ? "" : "bottom-[12%] left-1/2"
          } ${isSubtitleEditMode ? (isDraggingSubtitle ? "cursor-grabbing" : "cursor-grab") : "cursor-default"} ${
            isShowingSubtitlePlaceholder ? "seyirlik-subtitle-overlay--placeholder" : ""
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
            <div key={`${line}-${index}`} className="seyirlik-subtitle-line-wrap">
              <span className="seyirlik-subtitle-line">{line}</span>
            </div>
          ))}

          {isSubtitleEditMode ? (
            <>
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--tl"
                aria-label={t("player.resizeSubtitlesTopLeft")}
                onPointerDown={(event) => handleSubtitleResizePointerDown(event, -1, -1)}
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--tr"
                aria-label={t("player.resizeSubtitlesTopRight")}
                onPointerDown={(event) => handleSubtitleResizePointerDown(event, 1, -1)}
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--bl"
                aria-label={t("player.resizeSubtitlesBottomLeft")}
                onPointerDown={(event) => handleSubtitleResizePointerDown(event, -1, 1)}
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--br"
                aria-label={t("player.resizeSubtitlesBottomRight")}
                onPointerDown={(event) => handleSubtitleResizePointerDown(event, 1, 1)}
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {progress.isBuffering && !error ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="rounded-full bg-black/50 p-4 backdrop-blur">
            <Loader2 className="h-10 w-10 animate-spin text-[var(--accent)]" />
          </div>
        </div>
      ) : null}

      <PlayerOverlay
        title={title}
        titleLogoUrl={titleLogoUrl}
        subtitle={subtitle}
        backTo={`/item/${item.Id}`}
        visible={areControlsVisible || !progress.isPlaying || controlsShouldStayVisible}
        isPlaying={progress.isPlaying}
        isPlayPausePending={partyWatch.isInGroup && partyWatch.isPlayPausePending}
        notice={notice}
        onTogglePlay={partyWatch.togglePlay}
        onControlsHoverStart={keepControlsVisible}
        onControlsHoverEnd={releaseControlsHover}
        seekFeedback={seekFeedback}
      />

      {isPartyWatchOpen ? <PartyWatchOverlay controller={partyWatch} /> : null}

      <PlayerControls
        visible={areControlsVisible || !progress.isPlaying || controlsShouldStayVisible}
        isPlaying={progress.isPlaying}
        playWaiting={partyWatch.isInGroup && partyWatch.isPlayPausePending}
        onControlsHoverStart={keepControlsVisible}
        onControlsHoverEnd={releaseControlsHover}
        seekPreviewLoading={fullscreenSeekPreview !== null}
        currentTime={progress.currentTime}
        duration={progress.duration}
        bufferedEnd={progress.bufferedEnd}
        volume={progress.volume}
        muted={progress.muted}
        itemId={item.Id}
        mediaSourceId={activeSource.mediaSourceId}
        onTogglePlay={partyWatch.togglePlay}
        onSeek={partyWatch.seekTo}
        onSeekPreview={handleSeekPreview}
        onSeekBy={handleSeekBy}
        onToggleMute={progress.toggleMute}
        onVolumeChange={progress.setVolume}
        onToggleFullscreen={toggleFullscreen}
        onOpenSettings={() => {
          setIsSettingsOpen((current) => !current);
          setIsPartyWatchOpen(false);
          showControls();
        }}
        source={activeSource}
        qualityOptions={qualityOptions}
        selectedQualityId={selectedQualityId}
        selectedAudioStreamIndex={selectedAudioStreamIndex}
        selectedSubtitleStreamIndex={selectedSubtitleStreamIndex}
        canSwitchAudio={canSwitchAudio}
        canSwitchSubtitles={canSwitchSubtitles}
        settingsOpen={isSettingsOpen}
        onSelectAutoQuality={handleSelectAutoQuality}
        onSelectQuality={handleSelectQuality}
        onSelectAudioStream={handleSelectAudioStream}
        onSelectSubtitleStream={handleSelectSubtitleStream}
      />

      {displayedPartyEventMessage ? (
        <div className="pointer-events-none absolute bottom-[calc(max(1rem,env(safe-area-inset-bottom))+5.8rem)] left-[max(1rem,env(safe-area-inset-left))] z-40">
          <div
            className={`rounded-full border-[var(--accent)]/35 bg-black/72 px-3 py-1.5 text-xs font-bold text-white/88 shadow-[0_18px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl will-change-transform ${
              isPartyEventToastLeaving
                ? "animate-[partyToastExit_420ms_cubic-bezier(0.4,0,0.2,1)_forwards]"
                : "animate-[partyToastEnter_520ms_cubic-bezier(0.16,1,0.3,1)_forwards]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="relative flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent)]/18 text-[var(--accent)]">
                <span className="absolute h-2 w-2 rounded-full bg-[var(--accent)] shadow-[0_0_12px_var(--accent)]" />
              </span>

              <span>{displayedPartyEventMessage}</span>
            </div>
          </div>
        </div>
      ) : null}

      {areControlsVisible || !progress.isPlaying || controlsShouldStayVisible ? (
        <div className="pointer-events-auto absolute right-[max(1rem,env(safe-area-inset-right))] top-[max(1rem,env(safe-area-inset-top))] z-40 flex flex-col items-end gap-3">
          <div className="flex items-center gap-2" data-party-watch-root>
            <button
              type="button"
              onClick={() => {
                setIsPartyWatchOpen((current) => !current);
                setIsSettingsOpen(false);
                showControls();
              }}
              className="relative flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.12] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              aria-label={t("party.title")}
              title={t("party.title")}
            >
              <Users size={18} />

              <span className="absolute right-[0.35rem] top-[0.50rem] flex h-2.5 w-2.5 items-center justify-center rounded-full bg-black">
                <span
                  className={`h-1.5 w-1.5 rounded-full border ${
                    partyWatch.isInGroup
                      ? "border-white/85 hover:border-white bg-white/85 hover:bg-white shadow-[0_0_12px_var(--accent)]"
                      : "border-white/85 hover:border-white bg-transparent"
                  }`}
                />
              </span>
            </button>

            <PlaybackInfoButton source={activeSource} onClick={() => setIsPlaybackInfoOpen(true)} />
          </div>

          {isPartyWatchOpen ? (
            <div data-party-watch-root>
              <PartyWatchControls controller={partyWatch} visible />
            </div>
          ) : null}
        </div>
      ) : null}

      {isPlaybackInfoOpen ? (
        <PlaybackInfoPanel
          source={activeSource}
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
