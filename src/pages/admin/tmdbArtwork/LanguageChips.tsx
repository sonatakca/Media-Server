import { useLanguage } from "../../../i18n/LanguageContext";
import {
  languageName,
  type ImageLanguageFilter,
  type LanguageOption,
} from "../tmdbArtworkModel";

/**
 * One section's language, as a row of choices rather than a drop-down.
 *
 * Every language the section actually has images in is on screen with its
 * count, so choosing Turkish logos is one click and it is visible before the
 * click that there are three of them.
 */
export function LanguageChips({
  options,
  value,
  onChange,
  label,
  describe,
}: {
  options: readonly LanguageOption[];
  value: ImageLanguageFilter;
  onChange: (value: ImageLanguageFilter) => void;
  label: string;
  /** A name for a value the defaults do not cover, such as `tr-TR`. */
  describe?: (value: ImageLanguageFilter) => string;
}) {
  const { t, language } = useLanguage();
  const name = (option: LanguageOption) =>
    describe
      ? describe(option.value)
      : option.value === "all"
        ? t("tmdbArtwork.allLanguages")
        : option.value === "none"
          ? t("tmdbArtwork.language.none")
          : languageName(option.value, language);

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-wrap gap-1.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              selected
                ? "border-[var(--accent)]/60 bg-[var(--accent)]/15 text-white"
                : "border-white/10 text-white/60 hover:border-white/25 hover:text-white"
            }`}
          >
            {name(option)}
            {option.count > 0 ? (
              <span className="tabular-nums text-white/40">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
