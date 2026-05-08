import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  buildConfiguredHlsPlaybackSource,
  buildSubtitleStreamUrl,
  getLogoImageUrl,
  getManualQualityOptions,
} from "../../lib/jellyfinApi";
import { attachSourceToVideo } from "../../lib/videoSource";
import type { AttachedVideoSource } from "../../lib/videoSource";
import { getDisplayTitle, getItemSubtitle } from "../../lib/format";
import { getVideoErrorDetails, type PlaybackTechnicalDetails } from "../../hooks/usePlaybackSource";
import { useAutoHideControls } from "../../hooks/useAutoHideControls";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { usePlayerProgress } from "../../hooks/usePlayerProgress";
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

interface SubtitleResizeState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScale: number;
  directionX: -1 | 1;
  directionY: -1 | 1;
}

const AUTO_QUALITY_ID = "auto";
const SUBTITLE_EDIT_PLACEHOLDER = "Example subtitle to edit.";
const DEFAULT_SUBTITLE_SCALE = 1;
const MIN_SUBTITLE_SCALE = 0.7;
const MAX_SUBTITLE_SCALE = 2.4;

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastTapRef = useRef<{ time: number; x: number } | null>(null);
  const lastProgressReportRef = useRef(0);
  const hasStartedRef = useRef(false);
  const sourceSwitchTokenRef = useRef(0);
  const pendingSourceRestoreRef = useRef<PendingSourceRestore | null>(null);
  const subtitleOverlayRef = useRef<HTMLDivElement | null>(null);
  const subtitleDragStateRef = useRef<SubtitleDragState | null>(null);
  const subtitleResizeStateRef = useRef<SubtitleResizeState | null>(null);
  const suppressPlayerTapUntilRef = useRef(0);
  const title = getDisplayTitle(item);
  const progress = usePlayerProgress(videoRef);
  const refreshProgress = progress.refresh;
  const { areControlsVisible, showControls } = useAutoHideControls({
    isPlaying: progress.isPlaying,
    disabled: Boolean(error),
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

  const [activeSource, setActiveSource] = useState<PlaybackSourceCandidate>(source);
  const [selectedQualityId, setSelectedQualityId] = useState(AUTO_QUALITY_ID);
  const [selectedAudioStreamIndex, setSelectedAudioStreamIndex] = useState<number | undefined>(() =>
    getDefaultAudioStreamIndex(source),
  );
  const [selectedSubtitleStreamIndex, setSelectedSubtitleStreamIndex] = useState<number>(() =>
    getDefaultSubtitleStreamIndex(source),
  );
  const [isPlaybackInfoOpen, setIsPlaybackInfoOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [lastVideoError, setLastVideoError] = useState<string | null>(null);
  const [activeSubtitleText, setActiveSubtitleText] = useState("");
  const [subtitlePosition, setSubtitlePosition] = useState<SubtitlePosition | null>(null);
  const [subtitleSize, setSubtitleSize] = useState<SubtitleSize>({ scale: DEFAULT_SUBTITLE_SCALE });
  const [isDraggingSubtitle, setIsDraggingSubtitle] = useState(false);
  const [isResizingSubtitle, setIsResizingSubtitle] = useState(false);
  const [isSubtitleEditMode, setIsSubtitleEditMode] = useState(false);
  const availablePlaybackCandidates = playbackCandidates.length > 0 ? playbackCandidates : [source];
  const qualityOptions = useMemo(() => getManualQualityOptions(activeSource.mediaSource), [activeSource.mediaSource]);
  const canSwitchAudio = Boolean(
    activeSource.mediaSource.Id && (activeSource.mediaSource.SupportsTranscoding || activeSource.mode === "Transcoding"),
  );
  const canSwitchSubtitles = Boolean(activeSource.mediaSourceId);

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

  useKeyboardShortcuts({
    enabled: true,
    onTogglePlay: partyWatch.togglePlay,
    onSeekBy: partyWatch.seekBy,
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

  const switchPlayerSource = useCallback(
    (nextSource: PlaybackSourceCandidate) => {
      const video = videoRef.current;

      if (nextSource.id === activeSource.id && nextSource.url === activeSource.url) {
        return;
      }

      sourceSwitchTokenRef.current += 1;
      const pendingRestore = pendingSourceRestoreRef.current;
      pendingSourceRestoreRef.current = {
        token: sourceSwitchTokenRef.current,
        currentTime: pendingRestore?.currentTime ?? video?.currentTime ?? progress.currentTime,
        wasPlaying: pendingRestore?.wasPlaying ?? (video ? !video.paused && !video.ended : progress.isPlaying),
      };
      setLastVideoError(null);
      setActiveSource(nextSource);
      showControls();
    },
    [activeSource.id, activeSource.url, progress.currentTime, progress.isPlaying, showControls],
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

    try {
      switchPlayerSource(
        shouldKeepAudioOverride ? buildConfiguredSource(bestSource, undefined, selectedAudioStreamIndex) : bestSource,
      );
    } catch (switchError) {
      console.warn("[Seyirlik Playback] Could not keep selected audio while returning to Auto quality", switchError);
      setSelectedAudioStreamIndex(defaultAudioIndex);
      switchPlayerSource(bestSource);
    }
  }, [availablePlaybackCandidates, buildConfiguredSource, selectedAudioStreamIndex, source, switchPlayerSource]);

  const handleSelectQuality = useCallback(
    (quality: PlaybackQualityOption) => {
      try {
        const nextSource = buildConfiguredSource(activeSource, quality);
        setSelectedQualityId(quality.id);
        switchPlayerSource(nextSource);
      } catch (switchError) {
        console.warn("[Seyirlik Playback] Could not switch quality", switchError);
      }
    },
    [activeSource, buildConfiguredSource, switchPlayerSource],
  );

  const handleSelectAudioStream = useCallback(
    (streamIndex: number) => {
      if (!canSwitchAudio) {
        return;
      }

      const selectedQuality = qualityOptions.find((quality) => quality.id === selectedQualityId);

      try {
        const nextSource = buildConfiguredSource(activeSource, selectedQuality, streamIndex);
        setSelectedAudioStreamIndex(streamIndex);
        switchPlayerSource(nextSource);
      } catch (switchError) {
        console.warn("[Seyirlik Playback] Could not switch audio stream", switchError);
      }
    },
    [activeSource, buildConfiguredSource, canSwitchAudio, qualityOptions, selectedQualityId, switchPlayerSource],
  );

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
      attachment?.destroy();
    };
  }, [activeSource.id, activeSource.mimeType, activeSource.url, onVideoFailure, partyWatch.shouldDeferAutoplay, refreshProgress]);

  useEffect(() => {
    return () => {
      if (hasStartedRef.current) {
        onPlaybackStopped?.(videoRef.current?.currentTime ?? 0);
      }
    };
  }, [onPlaybackStopped]);

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
    partyWatch.seekBy(isLeftSide ? -10 : 10);
    showControls();
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (isDraggingSubtitle || isResizingSubtitle || Date.now() < suppressPlayerTapUntilRef.current) {
      return;
    }

    if (event.pointerType !== "touch") {
      return;
    }

    const now = Date.now();
    const previousTap = lastTapRef.current;

    if (previousTap && now - previousTap.time < 320 && Math.abs(previousTap.x - event.clientX) < 70) {
      handleDoubleSeek(event.clientX);
      lastTapRef.current = null;
      return;
    }

    lastTapRef.current = { time: now, x: event.clientX };
    showControls();
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

  const subtitle = getItemSubtitle(item);
  const titleLogoUrl = item.ImageTags?.Logo ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 900) : "";
  const isSubtitleBeingEdited = isDraggingSubtitle || isResizingSubtitle || isSubtitleEditMode;
  const isShowingSubtitlePlaceholder = isSubtitleBeingEdited && activeSubtitleText.trim().length === 0;

  const subtitleLines = (isShowingSubtitlePlaceholder ? SUBTITLE_EDIT_PLACEHOLDER : activeSubtitleText)
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
      className="relative h-[100svh] min-h-[32rem] overflow-hidden bg-black text-white"
      onMouseMove={showControls}
      onPointerDown={showControls}
      onPointerUp={handlePointerUp}
      onDoubleClick={(event) => handleDoubleSeek(event.clientX)}
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
          aria-label="Drag subtitles"
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
                aria-label="Resize subtitles from top left"
                onPointerDown={(event) => handleSubtitleResizePointerDown(event, -1, -1)}
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--tr"
                aria-label="Resize subtitles from top right"
                onPointerDown={(event) => handleSubtitleResizePointerDown(event, 1, -1)}
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--bl"
                aria-label="Resize subtitles from bottom left"
                onPointerDown={(event) => handleSubtitleResizePointerDown(event, -1, 1)}
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--br"
                aria-label="Resize subtitles from bottom right"
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
        visible={areControlsVisible || !progress.isPlaying}
        isPlaying={progress.isPlaying}
        notice={notice}
        onTogglePlay={partyWatch.togglePlay}
      />

      <PartyWatchOverlay controller={partyWatch} />

      <PlayerControls
        visible={areControlsVisible || !progress.isPlaying}
        isPlaying={progress.isPlaying}
        currentTime={progress.currentTime}
        duration={progress.duration}
        bufferedEnd={progress.bufferedEnd}
        volume={progress.volume}
        muted={progress.muted}
        onTogglePlay={partyWatch.togglePlay}
        onSeek={partyWatch.seekTo}
        onSeekBy={partyWatch.seekBy}
        onToggleMute={progress.toggleMute}
        onVolumeChange={progress.setVolume}
        onToggleFullscreen={toggleFullscreen}
        onOpenSettings={() => setIsSettingsOpen((current) => !current)}
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

      {areControlsVisible || !progress.isPlaying ? (
        <div className="pointer-events-auto absolute right-[max(1rem,env(safe-area-inset-right))] top-[max(1rem,env(safe-area-inset-top))] z-40 flex flex-col items-end gap-3">
          <PartyWatchControls controller={partyWatch} visible={areControlsVisible || !progress.isPlaying} />
          <PlaybackInfoButton source={activeSource} onClick={() => setIsPlaybackInfoOpen(true)} />
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
