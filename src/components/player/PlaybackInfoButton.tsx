import { Info } from "lucide-react";
import type { PlaybackSourceCandidate } from "../../lib/types";
import { getPlaybackModeLabel, getPlaybackModeTone } from "../../lib/playbackDiagnostics";
import { useLanguage } from "../../i18n/LanguageContext";

interface PlaybackInfoButtonProps {
  source: PlaybackSourceCandidate;
  onClick: () => void;
}

export function PlaybackInfoButton({ source, onClick }: PlaybackInfoButtonProps) {
  const { t } = useLanguage();
  const label = getPlaybackModeLabel(source.mode, t);
  const tone = getPlaybackModeTone(source.mode);
  const suffix = source.isHls ? " · HLS" : source.mediaSource.Container ? ` · ${source.mediaSource.Container.toUpperCase()}` : "";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-8 items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold shadow-2xl backdrop-blur transition hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] ${tone}`}
      aria-label={t("playback.details")}
      title={t("playback.details")}
    >
      <Info size={14} className="shrink-0" />
      <span>{label}{suffix}</span>
    </button>
  );
}
