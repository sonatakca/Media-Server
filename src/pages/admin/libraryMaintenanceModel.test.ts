import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../lib/types";
import {
  MIXED_SUBTITLE_PREFERENCE_INDEX,
  createDraftFromItem,
  formatBitrate,
  formatBytes,
  getCommonSubtitlePreferenceIndex,
  getSubtitlePreferenceOptions,
  parseGenres,
  parseNumberOrUndefined,
} from "./libraryMaintenanceModel";

describe("libraryMaintenanceModel", () => {
  it("preserves metadata draft and form parsing behavior", () => {
    expect(
      createDraftFromItem({
        Id: "movie",
        Name: "Movie",
        SortName: "Movie, The",
        Overview: "Overview",
        ProductionYear: 2026,
        CommunityRating: 8.25,
        Genres: ["Drama", "Crime"],
      } as MediaItem),
    ).toEqual({
      name: "Movie",
      sortName: "Movie, The",
      overview: "Overview",
      productionYear: "2026",
      officialRating: "",
      communityRating: "8.25",
      genres: "Drama, Crime",
    });
    expect(parseNumberOrUndefined(" 8.25 ")).toBe(8.25);
    expect(parseNumberOrUndefined("not-a-number")).toBeUndefined();
    expect(parseGenres(" Drama, , Crime ")).toEqual(["Drama", "Crime"]);
  });

  it("preserves subtitle preference aggregation by stream index", () => {
    const first = {
      Id: "first",
      Name: "First",
      MediaSources: [
        {
          DefaultSubtitleStreamIndex: 2,
          MediaStreams: [{ Type: "Subtitle", Index: 2, Language: "tr" }],
        },
      ],
    } as MediaItem;
    const second = {
      Id: "second",
      Name: "Second",
      MediaSources: [
        {
          DefaultSubtitleStreamIndex: -1,
          MediaStreams: [{ Type: "subtitle", Index: 2, Language: "en" }],
        },
      ],
    } as MediaItem;

    expect(getCommonSubtitlePreferenceIndex([first, second])).toBe(
      MIXED_SUBTITLE_PREFERENCE_INDEX,
    );
    expect(getSubtitlePreferenceOptions([first, second])).toMatchObject([
      { index: 2, itemCount: 2 },
    ]);
  });

  it("preserves byte and bitrate formatting", () => {
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(undefined, "Unknown value")).toBe("Unknown value");
    expect(formatBitrate(8_500_000)).toBe("8.50 Mbps");
  });
});
