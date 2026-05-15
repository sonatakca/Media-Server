import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";

interface SeekFeedbackItem {
  amount: number;
  visible: boolean;
  rotation: number;
  pulse: number;
}

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
  onControlsHoverStart?: () => void;
  onControlsHoverEnd?: () => void;
  seekFeedback?: {
    backward: SeekFeedbackItem;
    forward: SeekFeedbackItem;
  };
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
  onControlsHoverStart,
  onControlsHoverEnd,
  seekFeedback,
}: PlayerOverlayProps) {
  const { t } = useLanguage();

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

  const backwardFeedback = seekFeedback?.backward;
  const forwardFeedback = seekFeedback?.forward;

  return (
    <>
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-black via-black/[0.52] to-transparent px-[max(0.65rem,env(safe-area-inset-left))] pb-8 pt-[max(0.55rem,env(safe-area-inset-top))] transition duration-300 sm:px-[max(1rem,env(safe-area-inset-left))] sm:pb-16 sm:pt-[max(1rem,env(safe-area-inset-top))] ${
          visible ? "translate-y-0 opacity-100" : "-translate-y-4 opacity-0"
        }`}
      >
        <div
          className="pointer-events-auto mx-auto flex max-w-[1500px] items-center justify-between gap-4"
          onMouseEnter={onControlsHoverStart}
          onMouseLeave={onControlsHoverEnd}
          onPointerEnter={onControlsHoverStart}
          onPointerLeave={onControlsHoverEnd}
        >
          <Link
            to={backTo}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/[0.18] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:h-12 sm:w-12"
            aria-label={t("player.backToDetails")}
          >
            <ArrowLeft size={22} strokeWidth={2.2} />
          </Link>

          <div className="min-w-0 flex-1">
            {titleLogoUrl ? (
              <img
                src={titleLogoUrl}
                alt={title}
                className="max-h-10 max-w-[min(20rem,52vw)] object-contain object-left drop-shadow-[0_10px_28px_rgba(0,0,0,0.85)] sm:max-h-12"
              />
            ) : (
              <p className="truncate text-base font-bold text-white sm:text-lg">
                {title}
              </p>
            )}

            {subtitle ? (
              <p className="mt-1 truncate text-sm text-white/[0.62]">
                {subtitle}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {notice ? (
        <div className="pointer-events-none absolute left-1/2 top-24 z-40 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-[var(--accent)]/30 bg-black/[0.78] px-4 py-3 text-center text-sm font-semibold text-white shadow-[0_18px_80px_rgba(0,0,0,0.55)] backdrop-blur-xl">
          {notice}
        </div>
      ) : null}

      {backwardFeedback ? (
        <div
          className={`seyirlik-seek-feedback seyirlik-seek-feedback--backward ${
            backwardFeedback.visible ? "seyirlik-seek-feedback--visible" : ""
          }`}
          aria-hidden="true"
        >
          <div
            className="seyirlik-seek-feedback__bubble"
            style={{
              animation:
                backwardFeedback.pulse > 0
                  ? `${
                      backwardFeedback.pulse % 2 === 0
                        ? "seekFeedbackButtonPressA"
                        : "seekFeedbackButtonPressB"
                    } 620ms cubic-bezier(0.16, 1, 0.3, 1) both`
                  : undefined,
            }}
          >
            <span
              className="seyirlik-seek-feedback__icon"
              style={{
                transform: `translate(-50%, -50%) rotate(${backwardFeedback.rotation}deg)`,
              }}
            >
              <RotateCcw size={60} strokeWidth={1.5} />
            </span>
            <span className="seyirlik-seek-feedback__number">
              {backwardFeedback.amount}
            </span>
          </div>
        </div>
      ) : null}

      {forwardFeedback ? (
        <div
          className={`seyirlik-seek-feedback seyirlik-seek-feedback--forward ${
            forwardFeedback.visible ? "seyirlik-seek-feedback--visible" : ""
          }`}
          aria-hidden="true"
        >
          <div
            className="seyirlik-seek-feedback__bubble"
            style={{
              animation:
                forwardFeedback.pulse > 0
                  ? `${
                      forwardFeedback.pulse % 2 === 0
                        ? "seekFeedbackButtonPressA"
                        : "seekFeedbackButtonPressB"
                    } 620ms cubic-bezier(0.16, 1, 0.3, 1) both`
                  : undefined,
            }}
          >
            <span
              className="seyirlik-seek-feedback__icon"
              style={{
                transform: `translate(-50%, -50%) rotate(${forwardFeedback.rotation}deg)`,
              }}
            >
              <RotateCw size={60} strokeWidth={1.5} />
            </span>
            <span className="seyirlik-seek-feedback__number">
              {forwardFeedback.amount}
            </span>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onTogglePlay}
        onMouseEnter={onControlsHoverStart}
        onMouseLeave={onControlsHoverEnd}
        onPointerEnter={onControlsHoverStart}
        onPointerLeave={onControlsHoverEnd}
        className={`absolute left-1/2 top-1/2 z-20 flex h-10 w-16 shrink-0 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/[0.75] text-white shadow-none backdrop-blur-lg transition duration-300 hover:scale-105 hover:bg-black/[0.6] focus:outline-none focus:ring-0 focus:ring-[var(--accent)] sm:h-24 sm:w-24 cursor-pointer ${
          visible || !isPlaying || isPlayPausePending
            ? "opacity-100"
            : "pointer-events-none opacity-0"
        }`}
        aria-label={isPlaying ? t("common.pause") : t("common.play")}
      >
        <span className="relative flex items-center justify-center">
          {showPlayPauseWave ? (
            <span className="seyirlik-play-pause-wave" />
          ) : null}

          {isPlaying ? (
            <Pause
              className="h-7 w-7 [filter:drop-shadow(0_2px_4px_rgba(0,0,0,0.45))_drop-shadow(0_0_7px_rgba(255,255,255,0.16))] sm:h-[42px] sm:w-[42px]"
              fill="currentColor"
              strokeWidth={2.2}
            />
          ) : (
            <Play
              className="ml-0.5 h-7 w-7 [filter:drop-shadow(0_2px_4px_rgba(0,0,0,0.45))_drop-shadow(0_0_7px_rgba(255,255,255,0.16))] sm:ml-1 sm:h-[44px] sm:w-[44px]"
              fill="currentColor"
              strokeWidth={2.2}
            />
          )}

          {isPlayPausePending ? (
            <LoaderCircle
              strokeWidth={1}
              className="absolute z-[-1] h-16 w-16 animate-[spin_1.8s_linear_infinite] text-[var(--accent)] drop-shadow-[0_0_10px_rgba(255,153,31,0.35)] sm:h-[122px] sm:w-[122px]"
            />
          ) : null}
        </span>
      </button>
    </>
  );
}
