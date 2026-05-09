import { useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, Pause, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";

interface PlayerOverlayProps {
  title: string;
  titleLogoUrl?: string;
  subtitle?: string | null;
  backTo: string;
  visible: boolean;
  isPlaying: boolean;
  isPlayPausePending?: boolean;
  notice?: string | null;
  onTogglePlay: () => void;
}

export function PlayerOverlay({
  title,
  titleLogoUrl,
  subtitle,
  backTo,
  visible,
  isPlaying,
  isPlayPausePending = false,
  notice,
  onTogglePlay,
}: PlayerOverlayProps) {
  const { t } = useLanguage()
  
  const wasPlayPausePendingRef = useRef(isPlayPausePending);
  const waveTimeoutRef = useRef<number | null>(null);
  const [showPlayPauseWave, setShowPlayPauseWave] = useState(false);

  useEffect(() => {
    const wasPending = wasPlayPausePendingRef.current;

    if (wasPending && !isPlayPausePending) {
      setShowPlayPauseWave(true);

      if (waveTimeoutRef.current !== null) {
        window.clearTimeout(waveTimeoutRef.current);
      }

      waveTimeoutRef.current = window.setTimeout(() => {
        setShowPlayPauseWave(false);
        waveTimeoutRef.current = null;
      }, 520);
    }

    wasPlayPausePendingRef.current = isPlayPausePending;
  }, [isPlayPausePending]);

  useEffect(() => {
    return () => {
      if (waveTimeoutRef.current !== null) {
        window.clearTimeout(waveTimeoutRef.current);
      }
    };
  }, []);

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
            {titleLogoUrl ? (
              <img
                src={titleLogoUrl}
                alt={title}
                className="max-h-10 max-w-[min(20rem,52vw)] object-contain object-left drop-shadow-[0_10px_28px_rgba(0,0,0,0.85)] sm:max-h-12"
              />
            ) : (
              <p className="truncate text-base font-bold text-white sm:text-lg">{title}</p>
            )}

            {subtitle ? <p className="mt-1 truncate text-sm text-white/[0.62]">{subtitle}</p> : null}
          </div>
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
          visible || !isPlaying || isPlayPausePending ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-label={isPlaying ? t("common.pause") : t("common.play")}
      >
        <span className="relative flex items-center justify-center">
          {showPlayPauseWave ? (
            <span className="seyirlik-play-pause-wave" />
          ) : null}

          {isPlaying ? (
            <Pause size={42} fill="currentColor" />
          ) : (
            <Play className="ml-1" size={44} fill="currentColor" />
          )}

          {isPlayPausePending ? (
            <LoaderCircle
              size={122}
              strokeWidth={1}
              className="absolute z-[-1] animate-[spin_1.8s_linear_infinite] text-[var(--accent)] drop-shadow-[0_0_10px_rgba(255,153,31,0.35)]"
            />
          ) : null}
        </span>
      </button>
    </>
  );
}