import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useLanguage } from "../i18n/LanguageContext";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";

interface BackButtonProps {
  fallbackTo?: string;
  className?: string;
}

const APP_ROUTE_HISTORY_KEY = "seyirlik.appRouteHistory";

function getFullPath(location: ReturnType<typeof useLocation>): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function readAppRouteHistory(): string[] {
  try {
    const rawValue = sessionStorage.getItem(APP_ROUTE_HISTORY_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : [];

    return Array.isArray(parsedValue)
      ? parsedValue.filter((entry) => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function writeAppRouteHistory(history: string[]) {
  sessionStorage.setItem(
    APP_ROUTE_HISTORY_KEY,
    JSON.stringify(history.slice(-30)),
  );
}

export function NonPlayerHistoryTracker() {
  const location = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    const currentPath = getFullPath(location);
    const history = readAppRouteHistory();
    const lastPath = history[history.length - 1];
    const previousPath = history[history.length - 2];

    if (lastPath === currentPath) {
      return;
    }

    if (navigationType === "REPLACE" && history.length > 0) {
      const replacedHistory = [...history.slice(0, -1), currentPath];
      const replacedPreviousPath = replacedHistory[replacedHistory.length - 2];

      writeAppRouteHistory(
        replacedPreviousPath === currentPath
          ? replacedHistory.slice(0, -1)
          : replacedHistory,
      );
      return;
    }

    // Handles browser/app back properly.
    // Example: home -> details, then back to home.
    // Instead of storing [home, details, home], collapse it back to [home].
    if (previousPath === currentPath) {
      writeAppRouteHistory(history.slice(0, -1));
      return;
    }

    history.push(currentPath);
    writeAppRouteHistory(history);
  }, [location, navigationType]);

  return null;
}

export function BackButton({
  fallbackTo = "/home",
  className = "",
}: BackButtonProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();
  const label = t("common.back") || "Back";

  const handleClick = () => {
    const currentPath = getFullPath(location);
    const history = readAppRouteHistory();

    const currentIndex = history.lastIndexOf(currentPath);
    const targetPath = currentIndex > 0 ? history[currentIndex - 1] : null;

    if (targetPath) {
      writeAppRouteHistory(history.slice(0, currentIndex));
      navigate(targetPath, { replace: true });
      return;
    }

    navigate(fallbackTo, { replace: true });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.08] px-4 text-sm font-semibold text-zinc-200  transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out hover:-translate-y-px hover:bg-white/[0.14] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black active:scale-[0.98] motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100 ${className}`}
      aria-label={label}
    >
      <ArrowLeft size={17} className="shrink-0" />
      <AnimatedWidth value={label}>
        <AnimatedText value={label} />
      </AnimatedWidth>
    </button>
  );
}
