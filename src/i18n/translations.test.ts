import { describe, expect, it } from "vitest";
import { IMAGE_TYPES } from "../server/ownApi/images/imageRoutes";
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

  /**
   * Trickplay is called trickplay.
   *
   * It used to be called "thumbnails" everywhere a person could see it, which
   * collided with the product's real thumbnails — cover art, provider images,
   * the `thumb` image type — and left a queue row next to a film describing an
   * operation it was not running.
   */
  it("names trickplay in every string that is about trickplay", () => {
    expect(en["maintenance.operation.trickplay.generate"]).toBe(
      "Generate trickplay",
    );
    expect(en["maintenance.operation.trickplay.scan"]).toBe(
      "Scan for missing trickplay",
    );
    expect(en["maintenance.phase.trickplay"]).toBe("Generating trickplay");
    expect(en["tasks.trickplay"]).toBe("Generating trickplay");
    expect(en["tasks.selecting"]).toBe("Scanning for missing trickplay");
    expect(en["tasks.trickplayGenerate"]).toBe("Trickplay");
    expect(en["tasks.trickplayScan"]).toBe("Trickplay sweep");
    expect(en["tasks.not-generated"]).toBe("No trickplay generated");
    expect(en["tasks.spriteCount"]).toBe("Trickplay sheets generated");
  });

  it("keeps trickplay a technical term in Turkish, inflected naturally", () => {
    expect(tr["maintenance.operation.trickplay.generate"]).toBe(
      "Trickplay oluştur",
    );
    expect(tr["maintenance.operation.trickplay.scan"]).toBe(
      "Eksik trickplay'leri tara",
    );
    expect(tr["maintenance.phase.trickplay"]).toBe("Trickplay oluşturuluyor");
    expect(tr["tasks.trickplay"]).toBe("Trickplay oluşturuluyor");
    expect(tr["tasks.not-generated"]).toBe("Trickplay oluşturulmadı");
  });

  it("no longer calls trickplay generation a thumbnail operation", () => {
    for (const [language, dictionary] of Object.entries(translations)) {
      for (const [key, value] of Object.entries(dictionary)) {
        if (!/trickplay|spriteCount/i.test(key)) continue;
        expect(
          /thumbnail|küçük resim|küçük görsel/i.test(value),
          `${language}.${key} still calls trickplay a thumbnail`,
        ).toBe(false);
      }
    }
  });

  /**
   * The other half of that change, and the reason it was not a global search
   * and replace: this product has real thumbnails and they keep their name.
   *
   * `thumb` is one of the artwork types a title can carry, alongside `cover`,
   * `backdrop`, `logo` and `banner`. It has nothing to do with trickplay, and a
   * rename that swept it up would have broken the image API's contract.
   */
  it("leaves the artwork thumbnail type untouched", () => {
    expect(IMAGE_TYPES).toContain("thumb");
    expect(IMAGE_TYPES).not.toContain("trickplay");
    // The artwork strings that exist are about artwork, and none of them was
    // rewritten to say trickplay.
    for (const [key, value] of Object.entries(en)) {
      if (!/artwork|image|logo|cover|backdrop/i.test(key)) continue;
      expect(
        /trickplay/i.test(value),
        `${key} was rewritten as trickplay but is about artwork`,
      ).toBe(false);
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
