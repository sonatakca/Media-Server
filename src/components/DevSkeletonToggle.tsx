import { Eye, EyeOff } from "lucide-react";
import { useLanguage } from "../i18n/LanguageContext";
import {
  isDevSkeletonModeAvailable,
  setDevSkeletonMode,
  useDevSkeletonMode,
} from "../lib/devSkeletonMode";

export function DevSkeletonToggle() {
  const { t } = useLanguage();
  const isForced = useDevSkeletonMode();

  if (!isDevSkeletonModeAvailable()) return null;

  return (
    <button
      type="button"
      onClick={() => setDevSkeletonMode(!isForced)}
      aria-pressed={isForced}
      className={`fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-4 z-[120] inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-xs font-black uppercase tracking-[0.1em] shadow-2xl backdrop-blur-xl transition sm:bottom-6 sm:right-6 ${
        isForced
          ? "border-amber-300/40 bg-amber-300 text-black hover:bg-amber-200"
          : "border-white/15 bg-black/80 text-white/72 hover:border-white/30 hover:text-white"
      }`}
    >
      {isForced ? <EyeOff size={16} /> : <Eye size={16} />}
      {isForced
        ? t("devtools.skeletonLab.hideSkeletons")
        : t("devtools.skeletonLab.showSkeletons")}
    </button>
  );
}
