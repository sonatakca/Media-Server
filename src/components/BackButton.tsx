import { useEffect, type CSSProperties } from "react";
import { ChevronLeft } from "lucide-react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useLanguage } from "../i18n/LanguageContext";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";
import { glassSegmentedToolbar } from "./ui/glassControlStyles";

interface BackButtonProps {
  fallbackTo?: string;
  className?: string;
  buttonClassName?: string;
  style?: CSSProperties;
  buttonStyle?: CSSProperties;
  label?: string;
  noYShift?: boolean;
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
  buttonClassName = "",
  style,
  buttonStyle,
  label,
  noYShift = false,
}: BackButtonProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();

  const fallbackLabel = t("common.back");
  const trimmedLabel = (label ?? fallbackLabel).trim();
  const hasLabel = trimmedLabel.length > 0;

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
    <span
      style={style}
      className={`group/back-button ${glassSegmentedToolbar} transition-[background-color,border-color,box-shadow,transform,opacity] duration-150 ease-out hover:border-white/16 hover:bg-white/[0.09] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.075),inset_0_-1px_0_rgba(0,0,0,0.24),0_0_12px_rgba(255,255,255,0.035),0_10px_35px_rgba(0,0,0,0.28)] ${
        noYShift
          ? ""
          : "hover:-translate-y-px motion-reduce:hover:translate-y-0"
      } ${className}`}
    >
      <button
        type="button"
        onClick={handleClick}
        style={buttonStyle}
        className={`relative inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-full border border-transparent bg-transparent text-sm font-semibold text-white/78 transition-[color,opacity,transform] duration-150 ease-out group-hover/back-button:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 motion-reduce:active:scale-100 ${
          hasLabel
            ? "gap-2 px-4 active:scale-[0.96]"
            : "h-10 w-10 px-0 active:scale-[0.94]"
        } ${buttonClassName}`}
        aria-label={hasLabel ? trimmedLabel : fallbackLabel}
      >
        <ChevronLeft size={17} className="shrink-0" />
        {hasLabel ? (
          <AnimatedWidth value={trimmedLabel}>
            <AnimatedText value={trimmedLabel} />
          </AnimatedWidth>
        ) : null}
      </button>
    </span>
  );
}
