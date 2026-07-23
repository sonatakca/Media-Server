import { en } from "./translations/en";
import { tr } from "./translations/tr";

export type Language = "en" | "tr";

export const LANGUAGE_STORAGE_KEY = "seyirlik-language";

export const SUPPORTED_LANGUAGES: Language[] = ["en", "tr"];

export type TranslationKey = keyof typeof en;

export const translations = {
  en,
  tr,
} satisfies Record<Language, Record<TranslationKey, string>>;
