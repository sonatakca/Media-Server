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
      "Some Jellyfin data could not load",
    );
    expect(translations.tr["home.someDataFailed"]).toBe(
      "Bazı Jellyfin verileri yüklenemedi",
    );
  });
});
