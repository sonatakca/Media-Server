import { Volume1, Volume2, VolumeX } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";

interface VolumeControlProps {
  volume: number;
  muted: boolean;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
}

export function VolumeControl({
  volume,
  muted,
  onToggleMute,
  onVolumeChange,
}: VolumeControlProps) {
  const { t } = useLanguage();
  const Icon =
    muted || volume === 0 ? VolumeX : volume < 0.55 ? Volume1 : Volume2;

  return (
    <div className="group flex items-center gap-2">
      <button
        type="button"
        onClick={onToggleMute}
        className="flex h-11 w-11 items-center justify-center rounded-full text-white transition hover:bg-white/[0.12] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        aria-label={muted ? t("player.unmute") : t("player.mute")}
      >
        <Icon size={22} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        onChange={(event) => onVolumeChange(Number(event.target.value))}
        aria-label={t("player.volume")}
        className="seyir-slider seyirlik-player-volume-slider hidden h-1.5 w-20 cursor-pointer appearance-none rounded-full bg-white/20 accent-[var(--accent)] sm:block lg:w-28"
      />
    </div>
  );
}
