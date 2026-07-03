import { useLanguage } from "../i18n/LanguageContext";

interface LoadingSpinnerProps {
  label?: string;
}

export function LoadingSpinner({ label }: LoadingSpinnerProps) {
  const { t } = useLanguage();

  return (
    <div className="flex min-h-48 items-center justify-center gap-3 text-2xl font-semibold text-white/70">
      <span className="h-24 w-24 animate-spin rounded-full border-[0.2rem] border-white/15 border-t-white" />
      <span>{label ?? t("common.loading")}</span>
    </div>
  );
}
