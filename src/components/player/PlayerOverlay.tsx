import { ArrowLeft, Pause, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import type { PlaybackMode } from "../../lib/types";

interface PlayerOverlayProps {
  title: string;
  subtitle?: string | null;
  backTo: string;
  visible: boolean;
  isPlaying: boolean;
  notice?: string | null;
  playbackMode?: PlaybackMode;
  onTogglePlay: () => void;
}

export function PlayerOverlay({
  title,
  subtitle,
  backTo,
  visible,
  isPlaying,
  notice,
  playbackMode,
  onTogglePlay,
}: PlayerOverlayProps) {
  const { t } = useLanguage();

  return (
    <>
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-black via-black/[0.62] to-transparent px-[max(1rem,env(safe-area-inset-left))] pb-16 pt-[max(1rem,env(safe-area-inset-top))] transition duration-300 ${
          visible ? "translate-y-0 opacity-100" : "-translate-y-4 opacity-0"
        }`}
      >
        <div className="pointer-events-auto mx-auto flex max-w-[1500px] items-center justify-between gap-4">
          <Link
            to={backTo}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/[0.18] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            aria-label={t("player.backToDetails")}
          >
            <ArrowLeft size={23} />
          </Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-bold text-white sm:text-lg">{title}</p>
            {subtitle ? <p className="mt-0.5 truncate text-sm text-white/[0.62]">{subtitle}</p> : null}
          </div>
          {playbackMode ? (
            <span className="hidden rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/85 backdrop-blur sm:inline-flex">
              {playbackMode}
            </span>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div className="pointer-events-none absolute left-1/2 top-24 z-40 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-[var(--accent)]/30 bg-black/[0.78] px-4 py-3 text-center text-sm font-semibold text-white shadow-[0_18px_80px_rgba(0,0,0,0.55)] backdrop-blur-xl">
          {notice}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onTogglePlay}
        className={`absolute left-1/2 top-1/2 z-20 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/[0.16] text-white shadow-[0_22px_90px_rgba(0,0,0,0.62)] backdrop-blur-xl transition duration-300 hover:scale-105 hover:bg-white/[0.24] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:h-24 sm:w-24 ${
          visible || !isPlaying ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-label={isPlaying ? t("common.pause") : t("common.play")}
      >
        {isPlaying ? <Pause size={42} fill="currentColor" /> : <Play className="ml-1" size={44} fill="currentColor" />}
      </button>
    </>
  );
}
