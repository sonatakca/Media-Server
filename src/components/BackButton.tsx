import { ArrowLeft } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useLanguage } from "../i18n/LanguageContext";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";

interface BackButtonProps {
  fallbackTo?: string;
  className?: string;
}

export function BackButton({ fallbackTo = "/home", className = "" }: BackButtonProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();
  const label = t("common.back") || "Back";

  const handleClick = () => {
    const hasUsefulHistory =
      typeof window !== "undefined" && window.history.length > 1 && location.key !== "default";

    if (hasUsefulHistory) {
      navigate(-1);
      return;
    }

    navigate(fallbackTo, { replace: true });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.08] px-4 text-sm font-semibold text-zinc-200 backdrop-blur transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out hover:-translate-y-px hover:bg-white/[0.14] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black active:scale-[0.98] motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100 ${className}`}
      aria-label={label}
    >
      <ArrowLeft size={17} className="shrink-0" />
      <AnimatedWidth value={label}>
        <AnimatedText value={label} />
      </AnimatedWidth>
    </button>
  );
}
