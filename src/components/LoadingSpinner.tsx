import { useEffect } from "react";
import { useLanguage } from "../i18n/LanguageContext";
import { beginLoadingActivity } from "../lib/loadingActivity";

interface LoadingSpinnerProps {
  label?: string;
  className?: string;
  variant?: "compact" | "brand";
}

interface BrandLoadingMarkProps {
  className?: string;
}

const BRAND_ANIMATION_URL =
  "/artwork/seyirlik/animations/seyirlik-loading.webp";
const BRAND_STILL_URL =
  "/artwork/seyirlik/animations/seyirlik-loading-still.webp";

export function BrandLoadingMark({ className }: BrandLoadingMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={`relative block aspect-square ${className ?? "w-[min(10rem,36vw)]"}`}
    >
      <img
        src={BRAND_ANIMATION_URL}
        alt=""
        draggable={false}
        decoding="async"
        className="absolute inset-0 h-full w-full object-contain motion-reduce:hidden"
      />
      <img
        src={BRAND_STILL_URL}
        alt=""
        draggable={false}
        decoding="async"
        className="absolute inset-0 hidden h-full w-full object-contain motion-reduce:block"
      />
    </span>
  );
}

export function LoadingSpinner({
  label,
  className,
  variant = "compact",
}: LoadingSpinnerProps) {
  const { t } = useLanguage();
  const displayLabel = label ?? t("common.loading");
  const accessibleLabel = displayLabel || t("common.loading");

  // A spinner on screen is something loading, including a lazy route's fallback.
  useEffect(() => beginLoadingActivity(), []);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={accessibleLabel}
      className={`flex min-h-48 items-center justify-center text-2xl font-semibold ${className ?? "text-white/70"} ${
        variant === "brand" ? "flex-col" : ""
      } ${displayLabel ? "gap-3" : ""}`}
    >
      {variant === "brand" ? (
        <BrandLoadingMark />
      ) : (
        <span
          aria-hidden="true"
          className="h-24 w-24 animate-spin rounded-full border-[0.2rem] border-white/15 border-t-white motion-reduce:animate-none"
        />
      )}
      {displayLabel ? <span aria-hidden="true">{displayLabel}</span> : null}
    </div>
  );
}
