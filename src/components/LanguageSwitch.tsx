import { useEffect, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";

export function LanguageSwitch() {
  const { language, toggleLanguage, t } = useLanguage();
  const isEnglish = language === "en";
  const flagClass = isEnglish ? "fi-gb" : "fi-tr";
  const [displayFlagClass, setDisplayFlagClass] = useState(flagClass);
  const [isFlagVisible, setIsFlagVisible] = useState(true);

  useEffect(() => {
    if (flagClass === displayFlagClass) {
      return undefined;
    }

    setIsFlagVisible(false);

    const timeoutId = window.setTimeout(() => {
      setDisplayFlagClass(flagClass);
      window.requestAnimationFrame(() => setIsFlagVisible(true));
    }, 90);

    return () => window.clearTimeout(timeoutId);
  }, [displayFlagClass, flagClass]);

  return (
    <button
      type="button"
      onClick={toggleLanguage}
      title={
        isEnglish
          ? t("nav.language.switchToTurkish")
          : t("nav.language.switchToEnglish")
      }
      aria-label={
        isEnglish
          ? t("nav.language.ariaToTurkish")
          : t("nav.language.ariaToEnglish")
      }
      className="inline-flex min-h-10 w-[76px] items-center justify-center rounded-full border border-white/10 bg-white/[0.08] px-0 py-1.5 text-sm font-semibold text-white/[0.90] backdrop-blur transition-[background-color,border-color,color,transform] duration-300 ease-out hover:border-white/20 hover:bg-white/[0.12] active:scale-95 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
    >
      <span className="grid w-[54px] grid-cols-[22px_24px] items-center justify-center gap-2">
        <span
          className={`fi ${displayFlagClass} block h-[14px] w-[22px] shrink-0 rounded-sm shadow-sm transition-[opacity,transform] duration-200 ease-out ${
            isFlagVisible
              ? "translate-y-0 opacity-100"
              : "-translate-y-0.5 opacity-0"
          }`}
        />

        <span className="flex w-6 justify-center overflow-hidden">
          <AnimatedWidth value={isEnglish ? "EN" : "TR"} safetyPx={0}>
            <AnimatedText value={isEnglish ? "EN" : "TR"} />
          </AnimatedWidth>
        </span>
      </span>
    </button>
  );
}
