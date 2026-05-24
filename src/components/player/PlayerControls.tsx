import {
  Loader2,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { SeekBar, type SeekPointerAxis } from "./SeekBar";
import { VolumeControl } from "./VolumeControl";
import { PlayerSettingsPanel } from "./PlayerSettingsPanel";
import type {
  PlaybackQualityOption,
  PlaybackSourceCandidate,
} from "../../lib/types";

interface PlayerControlsProps {
  visible: boolean;
  isPlaying: boolean;
  playWaiting: boolean;
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  volume: number;
  muted: boolean;
  source: PlaybackSourceCandidate;
  qualityOptions: PlaybackQualityOption[];
  selectedQualityId: string;
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex: number;
  canSwitchAudio: boolean;
  canSwitchSubtitles: boolean;
  settingsOpen: boolean;
  itemId: string;
  mediaSourceId?: string;
  checkpointSeconds?: number | null;
  seekPreviewLoading?: boolean;
  seekPointerAxis?: SeekPointerAxis;
  compactSeekPreview?: boolean;
  compactLayout?: boolean;
  onTogglePlay: () => void;
  onControlsHoverStart?: () => void;
  onControlsHoverEnd?: () => void;
  onSeek: (seconds: number) => void;
  onSeekBy: (seconds: number) => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleFullscreen: () => void;
  onOpenSettings: () => void;
  onSelectAutoQuality: () => void;
  onSelectQuality: (quality: PlaybackQualityOption) => void;
  onSelectAudioStream: (streamIndex: number) => void;
  onSelectSubtitleStream: (streamIndex: number) => void;
  onSeekPreview?: (seconds: number) => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  }

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function PlayerControls({
  visible,
  isPlaying,
  playWaiting,
  currentTime,
  duration,
  bufferedEnd,
  volume,
  muted,
  source,
  qualityOptions,
  selectedQualityId,
  selectedAudioStreamIndex,
  selectedSubtitleStreamIndex,
  canSwitchAudio,
  canSwitchSubtitles,
  settingsOpen,
  itemId,
  mediaSourceId,
  checkpointSeconds,
  seekPreviewLoading = false,
  seekPointerAxis = "horizontal",
  compactSeekPreview = false,
  compactLayout = false,
  onTogglePlay,
  onControlsHoverStart,
  onControlsHoverEnd,
  onSeek,
  onSeekBy,
  onToggleMute,
  onVolumeChange,
  onToggleFullscreen,
  onOpenSettings,
  onSelectAutoQuality,
  onSelectQuality,
  onSelectAudioStream,
  onSelectSubtitleStream,
  onSeekPreview,
}: PlayerControlsProps) {
  const { t } = useLanguage();

  return (
    <div
      data-mobile-tight-controls
      className={`seyirlik-player-bottom-chrome pointer-events-none absolute inset-x-0 bottom-0 z-30 px-[max(0.55rem,env(safe-area-inset-left))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 transition duration-500 sm:px-[max(1rem,env(safe-area-inset-left))] sm:pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pt-14 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-28 opacity-0"
      }`}
    >
      <div
        className="seyirlik-player-controls-inner pointer-events-auto mx-auto w-[95%]"
        onMouseEnter={onControlsHoverStart}
        onMouseLeave={onControlsHoverEnd}
        onPointerEnter={onControlsHoverStart}
        onPointerLeave={onControlsHoverEnd}
      >
        <div className="seyirlik-seekbar-position relative">
          <SeekBar
            currentTime={currentTime}
            duration={duration}
            bufferedEnd={bufferedEnd}
            itemId={itemId}
            mediaSourceId={mediaSourceId}
            checkpointSeconds={checkpointSeconds}
            onSeek={onSeek}
            onSeekPreview={onSeekPreview}
            pointerAxis={seekPointerAxis}
            compactPreview={compactSeekPreview}
          />
        </div>
        <div className="mt-1 flex items-center justify-between gap-1 sm:mt-3 sm:gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={onTogglePlay}
              disabled={playWaiting}
              className="seyirlik-player-main-toggle relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-black shadow-2xl transition hover:scale-105 hover:bg-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-wait disabled:hover:scale-100 sm:h-14 sm:w-14"
              aria-label={
                playWaiting
                  ? t("player.waitingForSyncPlay")
                  : isPlaying
                    ? t("common.pause")
                    : t("common.play")
              }
              title={playWaiting ? t("player.waitingForSyncPlay") : undefined}
            >
              {playWaiting ? (
                <>
                  <Loader2
                    size={38}
                    className="absolute animate-spin text-black/70 sm:size-12"
                    strokeWidth={2}
                  />
                  <Play
                    size={18}
                    className="ml-0.5 text-black"
                    fill="currentColor"
                    strokeWidth={2.4}
                  />
                </>
              ) : isPlaying ? (
                <Pause
                  size={25}
                  className="text-black sm:size-7"
                  fill="currentColor"
                  strokeWidth={2.4}
                />
              ) : (
                <Play
                  size={25}
                  className="ml-0.5 text-black sm:size-7"
                  fill="currentColor"
                  strokeWidth={2.4}
                />
              )}
            </button>
            <button
              type="button"
              onClick={() => onSeekBy(-5)}
              className="seyirlik-player-skip-control hidden h-11 w-11 items-center justify-center rounded-full text-white transition hover:bg-white/[0.12] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:flex"
              aria-label={t("player.rewind5")}
            >
              <RotateCcw size={21} />
            </button>
            <button
              type="button"
              onClick={() => onSeekBy(5)}
              className="seyirlik-player-skip-control hidden h-11 w-11 items-center justify-center rounded-full text-white transition hover:bg-white/[0.12] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:flex"
              aria-label={t("player.forward5")}
            >
              <RotateCw size={21} />
            </button>
            <VolumeControl
              volume={volume}
              muted={muted}
              onToggleMute={onToggleMute}
              onVolumeChange={onVolumeChange}
            />
            <div className="seyirlik-player-clock ml-0.5 flex min-w-[4.8rem] items-center gap-1 whitespace-nowrap text-xs font-medium text-white/[0.82] sm:ml-1 sm:min-w-[7.5rem] sm:gap-2 sm:text-sm">
              <span>
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              {seekPreviewLoading ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.08] px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-white/70">
                  <Loader2 className="h-3 w-3 animate-spin text-[var(--accent)]" />
                  <span className="hidden sm:inline">
                    {t("player.seeking")}
                  </span>
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <div className="relative" data-player-settings-root>
              {settingsOpen ? (
                <PlayerSettingsPanel
                  source={source}
                  qualityOptions={qualityOptions}
                  selectedQualityId={selectedQualityId}
                  selectedAudioStreamIndex={selectedAudioStreamIndex}
                  selectedSubtitleStreamIndex={selectedSubtitleStreamIndex}
                  canSwitchAudio={canSwitchAudio}
                  canSwitchSubtitles={canSwitchSubtitles}
                  compact={compactLayout}
                  onSelectAutoQuality={onSelectAutoQuality}
                  onSelectQuality={onSelectQuality}
                  onSelectAudioStream={onSelectAudioStream}
                  onSelectSubtitleStream={onSelectSubtitleStream}
                />
              ) : null}

              <button
                type="button"
                onClick={onOpenSettings}
                className="flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.12] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                aria-label={t("player.settingsLabel")}
                title={t("player.settingsTitle")}
              >
                <Settings size={22} strokeWidth={2.2} />
              </button>
            </div>
            <button
              type="button"
              onClick={onToggleFullscreen}
              className="flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.12] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              aria-label={t("player.fullscreen")}
            >
              <Maximize size={22} strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
