import { beforeEach, describe, expect, it } from "vitest";
import {
  buildItemWithPlaybackDefaults,
  getDefaultSubtitleStreamIndexForItem,
  getDefaultSubtitleStreamIndexForSource,
} from "./playbackDefaults";
import type { MediaItem, MediaSource, PlaybackSourceCandidate } from "./types";

const mediaSource: MediaSource = {
  Id: "file-1",
  DefaultSubtitleStreamIndex: 2,
  MediaStreams: [
    { Index: 2, Type: "Subtitle", Language: "eng", IsDefault: true },
    { Index: 10_000, Type: "Subtitle", Language: "tr", IsExternal: true },
  ],
};

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    Id: "item-1",
    Name: "Movie",
    MediaSources: [mediaSource],
    ...overrides,
  };
}

function source(): PlaybackSourceCandidate {
  return {
    id: "source-1",
    itemId: "item-1",
    mediaSourceId: "file-1",
    mode: "DirectPlay",
    url: "/movie.mp4",
    isHls: false,
    label: "Original",
    mediaSource,
    reason: "Test source",
    priority: 0,
  };
}

describe("default Turkish subtitles", () => {
  beforeEach(() => window.localStorage.clear());

  it("automatically selects Turkish when the item contains it", () => {
    expect(getDefaultSubtitleStreamIndexForItem(item())).toBe(10_000);
    expect(getDefaultSubtitleStreamIndexForSource(item(), source())).toBe(
      10_000,
    );
  });

  it("keeps subtitles off when Turkish is unavailable", () => {
    const withoutTurkish = {
      ...mediaSource,
      DefaultSubtitleStreamIndex: undefined,
      MediaStreams: mediaSource.MediaStreams?.filter(
        (stream) => stream.Language !== "tr",
      ),
    };
    const nextItem = item({ MediaSources: [withoutTurkish] });
    expect(getDefaultSubtitleStreamIndexForItem(nextItem)).toBe(-1);
  });

  it("respects an explicit per-item override", () => {
    const disabled = buildItemWithPlaybackDefaults(item(), {
      subtitleStreamIndex: -1,
    });
    expect(getDefaultSubtitleStreamIndexForSource(disabled, source())).toBe(-1);
  });
});
