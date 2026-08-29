/**
 * Language tags as they actually appear in media files.
 *
 * Containers carry ISO 639-1 and 639-2/B and 639-2/T interchangeably, sometimes
 * with a region suffix, sometimes with a display name where a code belongs, and
 * often with nothing at all. Policy has to compare them, so everything is
 * folded to one canonical three-letter code first.
 */

const ALIASES: Readonly<Record<string, string>> = {
  en: "eng",
  eng: "eng",
  english: "eng",
  tr: "tur",
  tur: "tur",
  tr_tr: "tur",
  turkish: "tur",
  turkce: "tur",
  fr: "fra",
  fra: "fra",
  fre: "fra",
  french: "fra",
  de: "deu",
  deu: "deu",
  ger: "deu",
  german: "deu",
  es: "spa",
  spa: "spa",
  esp: "spa",
  spanish: "spa",
  it: "ita",
  ita: "ita",
  italian: "ita",
  ja: "jpn",
  jpn: "jpn",
  japanese: "jpn",
  ru: "rus",
  rus: "rus",
  russian: "rus",
  pt: "por",
  por: "por",
  portuguese: "por",
  ar: "ara",
  ara: "ara",
  arabic: "ara",
  zh: "zho",
  zho: "zho",
  chi: "zho",
  chinese: "zho",
  ko: "kor",
  kor: "kor",
  korean: "kor",
  nl: "nld",
  nld: "nld",
  dut: "nld",
  dutch: "nld",
};

/** The tag used when a stream declares nothing, or something unusable. */
export const UNKNOWN_LANGUAGE = "und";

export function normalizeLanguage(value: string | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return UNKNOWN_LANGUAGE;
  // `en-GB`, `pt_BR`: the region never changes which programme track to keep.
  const base = raw.split(/[-_]/)[0] ?? "";
  const collapsed = raw.replace(/[-_]/g, "_");
  return (
    ALIASES[collapsed] ??
    ALIASES[base] ??
    (base.length === 3 ? base : UNKNOWN_LANGUAGE)
  );
}

export function isUnknownLanguage(value: string | undefined): boolean {
  return normalizeLanguage(value) === UNKNOWN_LANGUAGE;
}

/** A name an operator reads, for the languages the policy names explicitly. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  eng: "English",
  tur: "Turkish",
  fra: "French",
  deu: "German",
  spa: "Spanish",
  ita: "Italian",
  jpn: "Japanese",
  rus: "Russian",
  por: "Portuguese",
  ara: "Arabic",
  zho: "Chinese",
  kor: "Korean",
  nld: "Dutch",
  und: "Unknown",
};

export function languageDisplayName(value: string | undefined): string {
  const code = normalizeLanguage(value);
  return DISPLAY_NAMES[code] ?? code.toUpperCase();
}
