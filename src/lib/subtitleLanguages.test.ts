import { describe, expect, it } from "vitest";
import {
  isTurkishSubtitleLanguage,
  isVisibleSubtitleLanguage,
} from "./subtitleLanguages";

describe("visible subtitle languages", () => {
  it("allows English and Turkish ISO codes only", () => {
    expect(isVisibleSubtitleLanguage("en")).toBe(true);
    expect(isVisibleSubtitleLanguage("ENG")).toBe(true);
    expect(isVisibleSubtitleLanguage("tr")).toBe(true);
    expect(isVisibleSubtitleLanguage("tur")).toBe(true);
    expect(isVisibleSubtitleLanguage("rum")).toBe(false);
    expect(isVisibleSubtitleLanguage("hi")).toBe(false);
    expect(isVisibleSubtitleLanguage(undefined)).toBe(false);
  });

  it("recognises both Turkish ISO codes", () => {
    expect(isTurkishSubtitleLanguage("tr")).toBe(true);
    expect(isTurkishSubtitleLanguage("TUR")).toBe(true);
    expect(isTurkishSubtitleLanguage("eng")).toBe(false);
  });
});
