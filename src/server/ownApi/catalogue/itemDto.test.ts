import { describe, expect, it } from "vitest";
import { toItemDto, toUserStateDto, type ImageRecord } from "./itemDto";
import type { CatalogueItemRow } from "./catalogueRepository";

function row(overrides: Partial<CatalogueItemRow> = {}): CatalogueItemRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    libraryId: "22222222-2222-4222-8222-222222222222",
    parentId: null,
    seriesId: null,
    kind: "movie",
    title: "The Matrix",
    sortTitle: "matrix",
    originalTitle: null,
    overview: null,
    tagline: null,
    productionYear: 1999,
    premiereDate: new Date("1999-03-31T00:00:00Z"),
    officialRating: null,
    communityRating: null,
    runtimeMs: "8160000",
    indexNumber: null,
    parentIndexNumber: null,
    providerIds: { tmdb: "603" },
    childCount: 0,
    recursiveItemCount: 0,
    dateCreated: new Date("2026-01-01T00:00:00Z"),
    missingSince: null,
    logoLayout: null,
    seriesTitle: null,
    seasonTitle: null,
    genres: ["Science Fiction"],
    ...overrides,
  };
}

function image(overrides: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: "img-1",
    itemId: "11111111-1111-4111-8111-111111111111",
    imageType: "cover",
    imageIndex: 0,
    contentHash: "hash-1",
    width: 600,
    height: 900,
    ...overrides,
  };
}

describe("toItemDto", () => {
  it("emits native field names, millisecond runtimes and RFC 3339 dates", () => {
    const dto = toItemDto(row());

    expect(dto).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "movie",
      title: "The Matrix",
      runtimeMs: 8_160_000,
      productionYear: 1999,
      premiereDate: "1999-03-31T00:00:00.000Z",
      dateCreated: "2026-01-01T00:00:00.000Z",
      providerIds: { tmdb: "603" },
      genres: ["Science Fiction"],
      isMissing: false,
    });
  });

  it("never emits a runtime of zero for an unprobed item", () => {
    expect(toItemDto(row({ runtimeMs: null })).runtimeMs).toBeUndefined();
    expect(toItemDto(row({ runtimeMs: "0" })).runtimeMs).toBeUndefined();
  });

  it("omits absent optional fields rather than emitting nulls", () => {
    const dto = toItemDto(row());
    expect("overview" in dto).toBe(false);
    expect("tagline" in dto).toBe(false);
    expect("officialRating" in dto).toBe(false);
  });

  it("groups artwork by type and keeps backdrops ordered", () => {
    const dto = toItemDto(row(), {
      images: [
        image({ id: "b2", imageType: "backdrop", imageIndex: 1 }),
        image({ id: "b1", imageType: "backdrop", imageIndex: 0 }),
        image({ id: "p1", imageType: "cover", imageIndex: 0 }),
        image({ id: "l1", imageType: "logo", imageIndex: 0 }),
      ],
    });

    expect(dto.images.cover?.id).toBe("p1");
    expect(dto.images.logo?.id).toBe("l1");
    expect(dto.images.backdrops.map((backdrop) => backdrop.id)).toEqual([
      "b1",
      "b2",
    ]);
  });

  it("exposes the content hash as the cache tag", () => {
    const dto = toItemDto(row(), {
      images: [image({ contentHash: "abc123" })],
    });
    expect(dto.images.cover?.tag).toBe("abc123");
  });

  it("surfaces inherited series artwork separately from the item's own", () => {
    const dto = toItemDto(row({ kind: "episode" }), {
      images: [image({ id: "own-thumb", imageType: "thumb" })],
      inheritedImages: [
        image({ id: "series-poster", imageType: "cover" }),
        image({ id: "series-backdrop", imageType: "backdrop" }),
      ],
    });

    expect(dto.images.thumb?.id).toBe("own-thumb");
    expect(dto.images.cover).toBeUndefined();
    expect(dto.images.parentCover?.id).toBe("series-poster");
    expect(dto.images.parentBackdrops?.[0]?.id).toBe("series-backdrop");
  });

  it("reports an episode's season through seasonId", () => {
    const dto = toItemDto(
      row({
        kind: "episode",
        parentId: "33333333-3333-4333-8333-333333333333",
        seriesId: "44444444-4444-4444-8444-444444444444",
        seriesTitle: "Breaking Bad",
        seasonTitle: "Season 1",
      }),
    );

    expect(dto.seasonId).toBe("33333333-3333-4333-8333-333333333333");
    expect(dto.seriesId).toBe("44444444-4444-4444-8444-444444444444");
    expect(dto.seriesTitle).toBe("Breaking Bad");
  });

  it("includes child counts only for container kinds", () => {
    expect(toItemDto(row({ kind: "movie" })).childCount).toBeUndefined();
    expect(
      toItemDto(row({ kind: "series", childCount: 5, recursiveItemCount: 62 })),
    ).toMatchObject({ childCount: 5, recursiveItemCount: 62 });
  });

  it("flags an item whose files are missing", () => {
    expect(toItemDto(row({ missingSince: new Date() })).isMissing).toBe(true);
  });
});

describe("toUserStateDto", () => {
  const state = {
    itemId: "11111111-1111-4111-8111-111111111111",
    positionMs: "4080000",
    played: false,
    playCount: 1,
    isFavourite: true,
    lastPlayedAt: new Date("2026-02-02T10:00:00Z"),
    audioStreamIndex: 1,
    subtitleStreamIndex: null,
  };

  it("computes played percentage from the runtime", () => {
    expect(toUserStateDto(state, 8_160_000)?.playedPercentage).toBeCloseTo(50);
  });

  it("omits the percentage when the runtime is unknown", () => {
    expect(toUserStateDto(state, undefined)?.playedPercentage).toBeUndefined();
  });

  it("clamps a position that overruns the recorded runtime", () => {
    expect(
      toUserStateDto({ ...state, positionMs: "9999999999" }, 8_160_000)
        ?.playedPercentage,
    ).toBe(100);
  });

  it("omits stream selections that were never made", () => {
    const dto = toUserStateDto(state, 8_160_000);
    expect(dto?.audioStreamIndex).toBe(1);
    expect("subtitleStreamIndex" in (dto ?? {})).toBe(false);
  });

  it("returns undefined when the user has no state for the item", () => {
    expect(toUserStateDto(undefined, 1_000)).toBeUndefined();
  });
});
