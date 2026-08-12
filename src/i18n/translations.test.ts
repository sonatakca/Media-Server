import { describe, expect, it } from "vitest";
import { en } from "./translations/en";
import { tr } from "./translations/tr";
import {
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  translations,
  type TranslationKey,
} from "./translations";

describe("translations facade", () => {
  it("assembles both language dictionaries without changing their key contract", () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    expect(translations).toEqual({ en, tr });
    expect(SUPPORTED_LANGUAGES).toEqual(["en", "tr"]);
    expect(LANGUAGE_STORAGE_KEY).toBe("seyirlik-language");
  });

  it("retains exact representative English and Turkish strings", () => {
    const key: TranslationKey = "nav.home";

    expect(translations.en[key]).toBe("Home");
    expect(translations.tr[key]).toBe("Ana Sayfa");
    expect(translations.en["home.someDataFailed"]).toBe(
      "Some data could not load",
    );
    expect(translations.tr["home.someDataFailed"]).toBe(
      "Bazı veriler yüklenemedi",
    );
  });

  it("no longer names the previous backend in any user-facing string", () => {
    // Historical references belong in docs/migration-from-jellyfin.md, not in
    // anything a user can read.
    for (const [language, dictionary] of Object.entries(translations)) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(
          /jellyfin|emby/i.test(value),
          `${language}.${key} still names the previous backend`,
        ).toBe(false);
      }
    }
  });

  it("keeps both bundles on exactly the same keys", () => {
    // A key present in one language and missing from the other renders as a
    // raw key string to whoever is using that language.
    const englishKeys = new Set(Object.keys(en));
    const turkishKeys = new Set(Object.keys(tr));

    expect([...englishKeys].filter((key) => !turkishKeys.has(key))).toEqual([]);
    expect([...turkishKeys].filter((key) => !englishKeys.has(key))).toEqual([]);
  });
});
