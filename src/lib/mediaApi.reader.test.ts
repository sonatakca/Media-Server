import { afterEach, describe, expect, it, vi } from "vitest";
import { ownApiClient } from "../api/ownApi/client";
import type { ItemDto, ItemStreamsDto } from "../api/ownApi/dto";
import { getReaderFormat } from "../pages/reader/readerModel";
import { getReaderItem } from "./mediaApi";

const ITEM_ID = "fb27652e-6f16-445a-8869-e27c01cab7c4";

function bookItem(): ItemDto {
  return {
    id: ITEM_ID,
    kind: "book",
    libraryId: "11111111-1111-4111-8111-111111111111",
    title: "Ben, Kirke",
    sortTitle: "Ben, Kirke",
    genres: [],
    providerIds: {},
    dateCreated: "2026-08-12T00:00:00.000Z",
    isMissing: false,
    logoLayout: null,
    images: { backdrops: [] },
  };
}

function epubSource(): ItemStreamsDto {
  return {
    sources: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        container: "epub",
        sizeBytes: 1234,
        durationMs: null,
        bitrateBps: null,
        isPrimary: true,
        probeState: "probed",
        streams: [],
      },
    ],
  };
}

describe("reader item loading", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses path-free source metadata to recognize an EPUB with a clean title", async () => {
    const request = vi
      .spyOn(ownApiClient, "request")
      .mockImplementation(async (path) => {
        if (path === `/items/${ITEM_ID}`) return bookItem();
        if (path === `/items/${ITEM_ID}/streams`) return epubSource();
        throw new Error(`Unexpected request: ${path}`);
      });

    const item = await getReaderItem(ITEM_ID);

    expect(request).toHaveBeenCalledTimes(2);
    expect(item.Name).toBe("Ben, Kirke");
    expect(item.Path).toBeUndefined();
    expect(item.MediaSources?.[0]?.Container).toBe("epub");
    expect(getReaderFormat(item)).toBe("epub");
  });
});
