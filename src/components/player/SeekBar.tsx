import { useLanguage } from "../../i18n/LanguageContext";

interface SeekBarProps {
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  onSeek: (seconds: number) => void;
}

export function SeekBar({ currentTime, duration, bufferedEnd, onSeek }: SeekBarProps) {
  const { t } = useLanguage();
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

  return (
    <div className="relative h-7 w-full">
      <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/20">
        <div className="h-full bg-white/30" style={{ width: `${bufferedPercent}%` }} />
      </div>
      <div
        className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--accent)]"
        style={{ width: `${progressPercent}%` }}
      />
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(currentTime, duration || 0)}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label={t("player.seek")}
        className="seyir-slider absolute inset-0 h-7 w-full cursor-pointer appearance-none bg-transparent"
      />
    </div>
  );
}
