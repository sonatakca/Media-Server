import { AlertTriangle, RefreshCw, RadioTower } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";

interface PlayerErrorOverlayProps {
  message: string;
  details?: string;
  canTryTranscoded: boolean;
  onTryTranscoded: () => void;
  onRetry: () => void;
}

export function PlayerErrorOverlay({
  message,
  details,
  canTryTranscoded,
  onTryTranscoded,
  onRetry,
}: PlayerErrorOverlayProps) {
  const { t } = useLanguage();

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/[0.82] px-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl border border-white/[0.12] bg-[linear-gradient(145deg,rgba(24,24,27,0.94),rgba(5,5,5,0.94))] p-5 shadow-[0_24px_110px_rgba(0,0,0,0.76)] sm:p-6">
        <div className="flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-rose-200">
            <AlertTriangle size={24} />
          </span>
          <div>
            <h2 className="text-xl font-black text-white">
              {t("player.issue")}
            </h2>
            <p className="mt-2 leading-6 text-white/[0.72]">{message}</p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          {canTryTranscoded ? (
            <button
              type="button"
              onClick={onTryTranscoded}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-4 text-sm font-bold text-black transition hover:bg-[var(--accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            >
              <RadioTower size={18} />
              {t("player.tryTranscoded")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/[0.14] bg-white/10 px-4 text-sm font-bold text-white transition hover:bg-white/[0.16] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          >
            <RefreshCw size={18} />
            {t("common.retry")}
          </button>
        </div>

        {details ? (
          <details className="mt-5 rounded-lg border border-white/10 bg-black/[0.45] p-4">
            <summary className="cursor-pointer text-sm font-semibold text-white/[0.82]">
              {t("player.technicalDetails")}
            </summary>
            <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-white/[0.58]">
              {details}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
