import { Volume1, Volume2, VolumeX } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { Tooltip } from "../ui/Tooltip";

interface VolumeControlProps {
  volume: number;
  muted: boolean;
  isExpanded: boolean;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onRequestExpand: () => void;
}

export function VolumeControl({
  volume,
  muted,
  isExpanded,
  onToggleMute,
  onVolumeChange,
  onRequestExpand,
}: VolumeControlProps) {
  const { t } = useLanguage();
  const Icon =
    muted || volume === 0 ? VolumeX : volume < 0.55 ? Volume1 : Volume2;

  return (
    <div
      className={`flex h-11 items-center overflow-hidden rounded-full transition-[background-color,padding,width] duration-200 ease-out ${
        isExpanded ? "bg-white/[0.08] sm:w-36 lg:w-44" : "sm:w-11"
      }`}
    >
      <Tooltip
        content={muted ? t("player.unmute") : t("player.mute")}
        offset="3rem"
        shortcut="M"
        group="player-controls"
      >
        <button
          type="button"
          onClick={onToggleMute}
          onMouseEnter={onRequestExpand}
          onPointerEnter={onRequestExpand}
          onFocus={onRequestExpand}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          aria-label={muted ? t("player.unmute") : t("player.mute")}
        >
          <Icon size={22} />
        </button>
      </Tooltip>
      <Tooltip
        content={`${t("player.volume")} ${Math.round((muted ? 0 : volume) * 100)}%`}
        offset="4.3rem"
        group="player-controls"
      >
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(event) => onVolumeChange(Number(event.target.value))}
          onFocus={onRequestExpand}
          tabIndex={isExpanded ? 0 : -1}
          aria-label={t("player.volume")}
          className="seyir-slider seyirlik-player-volume-slider mr-3 hidden h-1.5 w-20 shrink-0 cursor-pointer appearance-none rounded-full bg-white/20 accent-[var(--accent)] sm:block lg:w-28"
        />
      </Tooltip>
    </div>
  );
}
