import { Maximize, Pause, Play, RotateCcw, RotateCw, Settings } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { SeekBar } from "./SeekBar";
import { VolumeControl } from "./VolumeControl";
import type { PlaybackMode } from "../../lib/types";

interface PlayerControlsProps {
  visible: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  volume: number;
  muted: boolean;
  playbackMode?: PlaybackMode;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onSeekBy: (seconds: number) => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleFullscreen: () => void;
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
  currentTime,
  duration,
  bufferedEnd,
  volume,
  muted,
  playbackMode,
  onTogglePlay,
  onSeek,
  onSeekBy,
  onToggleMute,
  onVolumeChange,
  onToggleFullscreen,
}: PlayerControlsProps) {
  const { t } = useLanguage();

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black via-black/70 to-transparent px-[max(1rem,env(safe-area-inset-left))] pb-[max(1rem,env(safe-area-inset-bottom))] pt-14 transition duration-300 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      }`}
    >
      <div className="pointer-events-auto mx-auto w-full max-w-[1500px]">
        <SeekBar currentTime={currentTime} duration={duration} bufferedEnd={bufferedEnd} onSeek={onSeek} />
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={onTogglePlay}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-black shadow-2xl transition hover:scale-105 hover:bg-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:h-14 sm:w-14"
              aria-label={isPlaying ? t("common.pause") : t("common.play")}
            >
              {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
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
            <span className="ml-1 min-w-[7.5rem] text-sm font-medium text-white/[0.82]">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-1 sm:gap-2">
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.12] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              aria-label={t("player.settingsLabel")}
              title={t("player.settingsTitle")}
            >
              <Settings size={21} />
            </button>
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
