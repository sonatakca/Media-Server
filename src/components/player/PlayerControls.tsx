import { Loader2, Maximize, Pause, Play, RotateCcw, RotateCw, Settings } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { SeekBar } from "./SeekBar";
import { VolumeControl } from "./VolumeControl";
import { PlayerSettingsPanel } from "./PlayerSettingsPanel";
import type { PlaybackQualityOption, PlaybackSourceCandidate } from "../../lib/types";

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
  seekPreviewLoading?: boolean;
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
  seekPreviewLoading = false,
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
      className={`pointer-events-none absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black via-black/70 to-transparent px-[max(0.75rem,env(safe-area-inset-left))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10 transition duration-300 sm:px-[max(1rem,env(safe-area-inset-left))] sm:pb-[max(1rem,env(safe-area-inset-bottom))] sm:pt-14 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      }`}
    >
      <div
        className="pointer-events-auto mx-auto w-full max-w-[1500px]"
        onMouseEnter={onControlsHoverStart}
        onMouseLeave={onControlsHoverEnd}
        onPointerEnter={onControlsHoverStart}
        onPointerLeave={onControlsHoverEnd}
      >
        <div className="relative">
          <SeekBar
            currentTime={currentTime}
            duration={duration}
            bufferedEnd={bufferedEnd}
            itemId={itemId}
            mediaSourceId={mediaSourceId}
            onSeek={onSeek}
            onSeekPreview={onSeekPreview}
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 sm:mt-3 sm:gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={onTogglePlay}
              disabled={playWaiting}
              className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-black shadow-2xl transition hover:scale-105 hover:bg-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-wait disabled:hover:scale-100 sm:h-14 sm:w-14"
              aria-label={playWaiting ? t("player.waitingForSyncPlay") : isPlaying ? t("common.pause") : t("common.play")}
              title={playWaiting ? t("player.waitingForSyncPlay") : undefined}
            >
              {playWaiting ? (
                <>
                  <Loader2 className="absolute h-8 w-8 animate-spin text-black/70 sm:h-9 sm:w-9" />
                  <Play className="ml-0.5 h-3.5 w-3.5 text-black sm:h-4 sm:w-4" fill="currentColor" />
                </>
              ) : isPlaying ? (
                <Pause size={24} fill="currentColor" />
              ) : (
                <Play size={24} fill="currentColor" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onSeekBy(-10)}
              className="hidden h-11 w-11 items-center justify-center rounded-full text-white transition hover:bg-white/[0.12] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:flex"
              aria-label={t("player.rewind10")}
            >
              <RotateCcw size={21} />
            </button>
            <button
              type="button"
              onClick={() => onSeekBy(10)}
              className="hidden h-11 w-11 items-center justify-center rounded-full text-white transition hover:bg-white/[0.12] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:flex"
              aria-label={t("player.forward10")}
            >
              <RotateCw size={21} />
            </button>
            <VolumeControl
              volume={volume}
              muted={muted}
              onToggleMute={onToggleMute}
              onVolumeChange={onVolumeChange}
            />
            <div className="ml-1 flex min-w-[5.6rem] items-center gap-2 whitespace-nowrap text-xs font-medium text-white/[0.82] sm:min-w-[7.5rem] sm:text-sm">
              <span>
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              {seekPreviewLoading ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.08] px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-white/70">
                  <Loader2 className="h-3 w-3 animate-spin text-[var(--accent)]" />
                  <span className="hidden sm:inline">{t("player.seeking")}</span>
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
                <Settings size={21} />
              </button>
            </div>
            <button
              type="button"
              onClick={onToggleFullscreen}
              className="flex h-11 w-11 items-center justify-center rounded-full text-white transition hover:bg-white/[0.12] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              aria-label={t("player.fullscreen")}
            >
              <Maximize size={21} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
