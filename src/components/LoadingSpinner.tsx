import { useLanguage } from "../i18n/LanguageContext";

interface LoadingSpinnerProps {
  label?: string;
}

export function LoadingSpinner({ label }: LoadingSpinnerProps) {
  const { t } = useLanguage();

  return (
    <div className="flex min-h-48 items-center justify-center gap-3 text-sm font-semibold text-white/70">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-[var(--accent)]" />
      <span>{label ?? t("common.loading")}</span>
    </div>
  );
}
