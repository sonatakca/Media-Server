import { useLanguage } from "../i18n/LanguageContext";

interface ErrorMessageProps {
  title?: string;
  message: string;
  details?: string;
  onRetry?: () => void;
}

export function ErrorMessage({ title, message, details, onRetry }: ErrorMessageProps) {
  const { t } = useLanguage();

  return (
    <div className="rounded-xl border border-white/10 bg-zinc-950/80 p-4 text-sm text-rose-50 shadow-[0_18px_80px_rgba(0,0,0,0.35)] backdrop-blur">
      <p className="font-semibold">{title ?? t("common.somethingWentWrong")}</p>
      <p className="mt-1 text-rose-100/80">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex min-h-10 items-center justify-center rounded-lg border border-white/15 bg-white/10 px-4 text-sm font-bold text-white transition hover:bg-white/[0.16] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        >
          {t("common.retry")}
        </button>
      ) : null}
      {details ? (
        <details className="mt-4 rounded-lg border border-white/10 bg-black/[0.35] p-3">
          <summary className="cursor-pointer font-semibold text-rose-50/90">{t("player.technicalDetails")}</summary>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-rose-50/65">
            {details}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
