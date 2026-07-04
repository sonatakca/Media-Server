import { useLanguage } from "../i18n/LanguageContext";

interface LoadingSpinnerProps {
  label?: string;
  className?: string;
}

export function LoadingSpinner({ label, className }: LoadingSpinnerProps) {
  const { t } = useLanguage();
  const displayLabel = label ?? t("common.loading");

  return (
    <div
      className={`flex min-h-48 items-center justify-center text-2xl font-semibold ${className ?? "text-white/70"} ${
        displayLabel ? "gap-3" : ""
      }`}
    >
      <span className="h-24 w-24 animate-spin rounded-full border-[0.2rem] border-white/15 border-t-white" />
      {displayLabel ? <span>{displayLabel}</span> : null}
    </div>
  );
}
