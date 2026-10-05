import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";
import {
  DEFAULT_READER_SETTINGS,
  EPUB_PREPARATION_TIMEOUT_MS,
  EPUB_REQUEST_CREDENTIALS,
  READER_PROGRESS_KEY,
  READER_SETTINGS_KEY,
  getReaderFormat,
  readReaderProgress,
  readStoredReaderSettings,
  writeReaderProgress,
} from "./reader/readerModel";

describe("readerModel", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it("preserves storage keys, defaults, and setting clamps", () => {
    expect(READER_SETTINGS_KEY).toBe("seyirlik.reader.settings");
    expect(READER_PROGRESS_KEY).toBe("seyirlik.reader.progress");
    expect(EPUB_PREPARATION_TIMEOUT_MS).toBe(15000);
    expect(EPUB_REQUEST_CREDENTIALS).toBe(true);
    expect(readStoredReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);

    localStorage.setItem(
      READER_SETTINGS_KEY,
      JSON.stringify({
        theme: "invalid",
        face: "comic",
        fontScale: 999,
        lineHeight: 0,
        width: 1,
        spotlight: "blinding",
      }),
    );
    expect(readStoredReaderSettings()).toEqual({
      theme: "night",
      face: "serif",
      fontScale: 145,
      lineHeight: 1.25,
      width: 48,
      spotlight: "soft",
    });

    // Settings saved before the reading light and the two new themes existed
    // keep their values and gain the defaults.
    localStorage.setItem(
      READER_SETTINGS_KEY,
      JSON.stringify({ theme: "sepia", fontScale: 110, lineHeight: 1.7, width: 74 }),
    );
    expect(readStoredReaderSettings()).toEqual({
      theme: "sepia",
      face: "serif",
      fontScale: 110,
      lineHeight: 1.7,
      width: 74,
      spotlight: "soft",
    });
  });

  it("preserves format-detection candidate precedence", () => {
    expect(
      getReaderFormat({
        Id: "book",
        Name: "book.pdf",
        Path: "/books/book.txt",
        MediaSources: [{ Container: "epub", Path: "/books/book.html" }],
      } as MediaItem),
    ).toBe("epub");
    expect(
      getReaderFormat({ Id: "image", Name: "cover.JPG?x=1" } as MediaItem),
    ).toBe("image");
    expect(
      getReaderFormat({ Id: "unknown", Name: "README" } as MediaItem),
    ).toBe("fallback");
  });

  it("merges stored progress and updates its timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T09:00:00.000Z"));
    writeReaderProgress("book", { cfi: "epubcfi(/6/2)" });
    writeReaderProgress("book", { scrollRatio: 0.5 });

    expect(readReaderProgress("book")).toEqual({
      cfi: "epubcfi(/6/2)",
      scrollRatio: 0.5,
      updatedAt: 1784797200000,
    });
  });
});
