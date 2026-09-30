import { describe, expect, it } from "vitest";
import { describeMediaSessionMetadata } from "./useMediaSessionControls";

describe("describeMediaSessionMetadata", () => {
  it("shows a film with its year and its own cover", () => {
    const metadata = describeMediaSessionMetadata({
      title: "Fight Club",
      item: {
        Id: "film-1",
        Type: "Movie",
        ProductionYear: 1999,
        ImageTags: { Primary: "tag-a" },
      },
    });
    expect(metadata.title).toBe("Fight Club");
    expect(metadata.artist).toBe("1999");
    expect(metadata.artwork?.[0]?.src).toContain("film-1");
  });

  it("shows an episode under its series, with the series cover", () => {
    const metadata = describeMediaSessionMetadata({
      title: "S1:E3 · Kıvılcım",
      item: {
        Id: "episode-3",
        Type: "Episode",
        SeriesId: "series-9",
        SeriesName: "Ezel",
        ImageTags: { Primary: "still" },
      },
    });
    expect(metadata.artist).toBe("Ezel");
    expect(metadata.artwork?.[0]?.src).toContain("series-9");
    expect(metadata.artwork?.[0]?.src).not.toContain("episode-3");
  });
});
