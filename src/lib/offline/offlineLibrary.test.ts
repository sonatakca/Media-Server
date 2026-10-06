import { describe, expect, it } from "vitest";
import type { MediaItem } from "../types";
import {
  offlineItem,
  offlinePlaybackSource,
  type OfflineTitle,
} from "./offlineLibrary";

const item = {
  Id: "item-1",
  Name: "Film",
  MediaSources: [
    {
      Id: "source-1",
      MediaStreams: [
        { Index: 0, Type: "Video" },
        { Index: 1, Type: "Audio", Language: "tur" },
        { Index: 2, Type: "Audio", Language: "eng" },
        { Index: 3, Type: "Audio", Language: "fre" },
        { Index: 4, Type: "Subtitle", Language: "tur" },
        { Index: 5, Type: "Subtitle", Language: "eng" },
      ],
    },
  ],
} as unknown as MediaItem;

function title(overrides: Partial<OfflineTitle> = {}): OfflineTitle {
  return {
    itemId: "item-1",
    item,
    masterUrl: "https://p.test/master.m3u8?height=1080",
    height: 1080,
    width: 1920,
    bitrate: 6_000_000,
    hdr: false,
    files: [],
    downloadedBytes: 0,
    estimatedBytes: 0,
    state: "complete",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const indexes = (stored: MediaItem) =>
  stored.MediaSources?.[0]?.MediaStreams?.map((stream) => stream.Index);

describe("offline item", () => {
  it("lists only the tracks the stored copy carries", () => {
    const stored = offlineItem(
      title({ audioStreamIndexes: [1, 2], subtitleStreamIndexes: [5] }),
    );
    expect(indexes(stored)).toEqual([0, 1, 2, 5]);
  });

  it("offers no subtitle from a copy stored before subtitles were kept", () => {
    expect(indexes(offlineItem(title()))).toEqual([0, 1, 2, 3]);
  });

  it("names the media source, which subtitles and thumbnails key on", () => {
    const source = offlinePlaybackSource(
      title({ audioStreamIndexes: [1], subtitleStreamIndexes: [4] }),
    );
    expect(source).toMatchObject({
      offline: true,
      mediaSourceId: "source-1",
      mediaSource: { Id: "source-1" },
    });
    expect(source.mediaSource.MediaStreams?.map((s) => s.Index)).toEqual([
      0, 1, 4,
    ]);
  });
});
