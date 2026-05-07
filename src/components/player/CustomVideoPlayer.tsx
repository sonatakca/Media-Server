import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Loader2 } from "lucide-react";
import { attachSourceToVideo } from "../../lib/videoSource";
import type { AttachedVideoSource } from "../../lib/videoSource";
import { getDisplayTitle, getItemSubtitle } from "../../lib/format";
import { getVideoErrorDetails, type PlaybackTechnicalDetails } from "../../hooks/usePlaybackSource";
import { useAutoHideControls } from "../../hooks/useAutoHideControls";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { usePlayerProgress } from "../../hooks/usePlayerProgress";
import type { JellyfinItem, PlaybackSourceCandidate } from "../../lib/types";
import { PlayerControls } from "./PlayerControls";
import { PlayerErrorOverlay } from "./PlayerErrorOverlay";
import { PlayerOverlay } from "./PlayerOverlay";
import { PlaybackInfoButton } from "./PlaybackInfoButton";
import { PlaybackInfoPanel } from "./PlaybackInfoPanel";

interface CustomVideoPlayerProps {
  item: JellyfinItem;
  source: PlaybackSourceCandidate;
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

export function CustomVideoPlayer({
  item,
  source,
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
  const progress = usePlayerProgress(videoRef);
  const { areControlsVisible, showControls } = useAutoHideControls({
    isPlaying: progress.isPlaying,
    disabled: Boolean(error),
  });

  const [isPlaybackInfoOpen, setIsPlaybackInfoOpen] = useState(false);
  const [lastVideoError, setLastVideoError] = useState<string | null>(null);

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
    onTogglePlay: progress.togglePlay,
    onSeekBy: progress.seekBy,
    onToggleMute: progress.toggleMute,
    onToggleFullscreen: toggleFullscreen,
  });

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    hasStartedRef.current = false;
    lastProgressReportRef.current = 0;

    let attachment: AttachedVideoSource | undefined;

    try {
      attachment = attachSourceToVideo(video, source.url, source.mimeType);
      source.usingHlsJs = attachment.usingHlsJs;
      video.load();
      void video.play().catch((playError: unknown) => {
        console.info("[Seyirlik Playback] Autoplay was blocked or deferred", playError);
      });
    } catch (attachError) {
      onVideoFailure(attachError instanceof Error ? attachError.message : String(attachError));
    }

    return () => {
      attachment?.destroy();
    };
  }, [onVideoFailure, source.id, source.mimeType, source.url]);

  useEffect(() => {
    return () => {
      if (hasStartedRef.current) {
        onPlaybackStopped?.(videoRef.current?.currentTime ?? 0);
      }
    };
  }, [onPlaybackStopped]);

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

    const details = getVideoErrorDetails(video, source);
    setLastVideoError(details);
    console.error("[Seyirlik Playback] video element error", details);
    onVideoFailure(details);
  };

  const handleDoubleSeek = (clientX: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();

    if (!bounds) {
      return;
    }

    const isLeftSide = clientX - bounds.left < bounds.width / 2;
    progress.seekBy(isLeftSide ? -10 : 10);
    showControls();
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
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

  const title = getDisplayTitle(item);
  const subtitle = getItemSubtitle(item);

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
        className="h-full w-full bg-black object-contain"
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

      {progress.isBuffering && !error ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="rounded-full bg-black/50 p-4 backdrop-blur">
            <Loader2 className="h-10 w-10 animate-spin text-[var(--accent)]" />
          </div>
        </div>
      ) : null}

      <PlayerOverlay
        title={title}
        subtitle={subtitle}
        backTo={`/item/${item.Id}`}
        visible={areControlsVisible || !progress.isPlaying}
        isPlaying={progress.isPlaying}
        notice={notice}
        playbackMode={source.mode}
        onTogglePlay={progress.togglePlay}
      />

      <PlayerControls
        visible={areControlsVisible || !progress.isPlaying}
        isPlaying={progress.isPlaying}
        currentTime={progress.currentTime}
        duration={progress.duration}
        bufferedEnd={progress.bufferedEnd}
        volume={progress.volume}
        muted={progress.muted}
        playbackMode={source.mode}
        onTogglePlay={progress.togglePlay}
        onSeek={progress.seekTo}
        onSeekBy={progress.seekBy}
        onToggleMute={progress.toggleMute}
        onVolumeChange={progress.setVolume}
        onToggleFullscreen={toggleFullscreen}
      />

      {areControlsVisible || !progress.isPlaying ? (
        <div className="pointer-events-auto absolute right-[max(1rem,env(safe-area-inset-right))] top-[calc(max(1rem,env(safe-area-inset-top))+4.5rem)] z-40">
          <PlaybackInfoButton source={source} onClick={() => setIsPlaybackInfoOpen(true)} />
        </div>
      ) : null}

      {isPlaybackInfoOpen ? (
        <PlaybackInfoPanel
          source={source}
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
