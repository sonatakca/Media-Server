const VISIBLE_SUBTITLE_LANGUAGES = new Set(["en", "eng", "tr", "tur"]);
const TURKISH_SUBTITLE_LANGUAGES = new Set(["tr", "tur"]);

/** Seyirlik intentionally offers only English and Turkish subtitle tracks. */
export function isVisibleSubtitleLanguage(
  language: string | null | undefined,
): boolean {
  return VISIBLE_SUBTITLE_LANGUAGES.has(language?.trim().toLowerCase() ?? "");
}

export function isTurkishSubtitleLanguage(
  language: string | null | undefined,
): boolean {
  return TURKISH_SUBTITLE_LANGUAGES.has(language?.trim().toLowerCase() ?? "");
}
