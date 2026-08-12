import { describe, expect, it } from "vitest";
import {
  buildRenditionRequirements,
  classifyQualityHeight,
  computeRenditionDimensions,
  isEligibleVideoPath,
} from "./policy";

describe("rendition policy", () => {
  it("plans 1080p, 720p and 480p for a 2160p source", () => {
    expect(
      buildRenditionRequirements({ width: 3840, height: 2160, rotation: 0 }),
    ).toEqual([
      { qualityHeight: 1080, width: 1920, height: 1080 },
      { qualityHeight: 720, width: 1280, height: 720 },
      { qualityHeight: 480, width: 854, height: 480 },
    ]);
  });

  it("plans 720p and 480p for a 1080p source", () => {
    expect(
      buildRenditionRequirements({ width: 1920, height: 1080, rotation: 0 }),
    ).toEqual([
      { qualityHeight: 720, width: 1280, height: 720 },
      { qualityHeight: 480, width: 854, height: 480 },
    ]);
  });

  it("plans only 480p for a 720p source", () => {
    expect(
      buildRenditionRequirements({ width: 1280, height: 720, rotation: 0 }),
    ).toEqual([{ qualityHeight: 480, width: 854, height: 480 }]);
  });

  it("classifies letterboxed masters by display long edge, not frame height", () => {
    // A 4K scope feature stores a 1604px frame height; the height-threshold
    // ladder used to cap it at 720p and never produce a 1080p file.
    expect(classifyQualityHeight({ width: 3840, height: 1604 })).toBe(2160);
    expect(
      buildRenditionRequirements({ width: 3840, height: 1604, rotation: 0 }),
    ).toEqual([
      { qualityHeight: 1080, width: 1920, height: 802 },
      { qualityHeight: 720, width: 1280, height: 534 },
      { qualityHeight: 480, width: 854, height: 356 },
    ]);

    expect(classifyQualityHeight({ width: 1920, height: 816 })).toBe(1080);
    expect(
      buildRenditionRequirements({ width: 1920, height: 816, rotation: 0 }),
    ).toEqual([
      { qualityHeight: 720, width: 1280, height: 544 },
      { qualityHeight: 480, width: 854, height: 362 },
    ]);
  });

  it("does not upscale or create meaningless lower renditions", () => {
    expect(
      buildRenditionRequirements({ width: 854, height: 480, rotation: 0 }),
    ).toEqual([]);
    expect(
      buildRenditionRequirements({ width: 1024, height: 576, rotation: 0 }),
    ).toEqual([]);
  });

  it("preserves unusual aspect ratios and produces even dimensions", () => {
    expect(computeRenditionDimensions(1920, 800, 854)).toEqual({
      width: 854,
      height: 356,
    });
    expect(computeRenditionDimensions(1919, 1080, 1280)).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("respects rotation metadata when selecting the display ladder", () => {
    // Rotated to portrait the display box is 2160x3840, so the long edge is the
    // height and the ladder scales that edge without ever stretching.
    expect(
      buildRenditionRequirements({ width: 3840, height: 2160, rotation: 90 }),
    ).toEqual([
      { qualityHeight: 1080, width: 1080, height: 1920 },
      { qualityHeight: 720, width: 720, height: 1280 },
      { qualityHeight: 480, width: 480, height: 854 },
    ]);
  });

  it("recognises videos while excluding Books and generated paths on Windows", () => {
    expect(
      isEligibleVideoPath("D:\\media\\Movies\\Çağrı 4K.mkv", "D:\\media"),
    ).toBe(true);
    expect(
      isEligibleVideoPath("D:\\media\\Series\\Dizi\\S01E01.MP4", "D:\\media"),
    ).toBe(true);
    expect(isEligibleVideoPath("D:\\media\\Books\\film.mp4", "D:\\media")).toBe(
      false,
    );
    expect(
      isEligibleVideoPath(
        "D:\\media\\.seyirlik\\renditions\\id\\segment000001.m4s",
        "D:\\media",
      ),
    ).toBe(false);
    expect(
      isEligibleVideoPath("D:\\media\\Movies\\poster.jpg", "D:\\media"),
    ).toBe(false);
  });

  it("skips sidecar derivatives written next to originals", () => {
    const root = "D:\\media";
    const movie = "D:\\media\\Movies\\Film (1999)\\Film (1999)";
    expect(isEligibleVideoPath(`${movie}.mp4`, root)).toBe(true);
    expect(isEligibleVideoPath(`${movie}-1080p-video.mp4`, root)).toBe(false);
    expect(isEligibleVideoPath(`${movie}-480p-video.tmp.mp4`, root)).toBe(
      false,
    );
    expect(isEligibleVideoPath(`${movie}-orig-video.mp4`, root)).toBe(false);
    expect(isEligibleVideoPath(`${movie}-audio.mp3`, root)).toBe(false);
    expect(isEligibleVideoPath(`${movie}.partial.mp4`, root)).toBe(false);
    // A legitimate title that merely mentions a resolution stays eligible.
    expect(isEligibleVideoPath(`${movie} (2160p BluRay x265).mp4`, root)).toBe(
      true,
    );
  });

  it("skips conventional extras folders while keeping real Specials seasons", () => {
    expect(
      isEligibleVideoPath(
        "D:\\media\\Movies\\Dune (2021)\\trailers\\Dune (2021) - Trailer.mp4",
        "D:\\media",
      ),
    ).toBe(false);
    expect(
      isEligibleVideoPath(
        "D:\\media\\Movies\\Star Wars (1977)\\Backdrops\\clip.mp4",
        "D:\\media",
      ),
    ).toBe(false);
    expect(
      isEligibleVideoPath(
        "D:\\media\\Series\\Dizi\\Behind The Scenes\\making-of.mkv",
        "D:\\media",
      ),
    ).toBe(false);
    expect(
      isEligibleVideoPath(
        "D:\\media\\Series\\Dizi\\Specials\\S00E01.mkv",
        "D:\\media",
      ),
    ).toBe(true);
  });
});
