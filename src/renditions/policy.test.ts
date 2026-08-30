import { describe, expect, it } from "vitest";
import {
  buildRenditionRequirements,
  classifyQualityHeight,
  computeRenditionDimensions,
  isEligibleVideoPath,
} from "./policy";

describe("rendition policy", () => {
  /**
   * The ladder reaches the source's own class as well as every rung below it.
   * That top rung is what makes the source file removable later: without it the
   * best copy of a title would only ever exist as the original.
   */
  it("plans the full ladder down from a 2160p source", () => {
    expect(
      buildRenditionRequirements({ width: 3840, height: 2160, rotation: 0 }),
    ).toEqual([
      { qualityHeight: 2160, width: 3840, height: 2160 },
      { qualityHeight: 1440, width: 2560, height: 1440 },
      { qualityHeight: 1080, width: 1920, height: 1080 },
      { qualityHeight: 720, width: 1280, height: 720 },
      { qualityHeight: 480, width: 854, height: 480 },
      { qualityHeight: 360, width: 640, height: 360 },
      { qualityHeight: 240, width: 426, height: 240 },
      { qualityHeight: 144, width: 256, height: 144 },
    ]);
  });

  it("never plans a rung above the source's own class", () => {
    expect(
      buildRenditionRequirements({ width: 1920, height: 1080, rotation: 0 }),
    ).toEqual([
      { qualityHeight: 1080, width: 1920, height: 1080 },
      { qualityHeight: 720, width: 1280, height: 720 },
      { qualityHeight: 480, width: 854, height: 480 },
      { qualityHeight: 360, width: 640, height: 360 },
      { qualityHeight: 240, width: 426, height: 240 },
      { qualityHeight: 144, width: 256, height: 144 },
    ]);

    expect(
      buildRenditionRequirements({ width: 1280, height: 720, rotation: 0 }),
    ).toEqual([
      { qualityHeight: 720, width: 1280, height: 720 },
      { qualityHeight: 480, width: 854, height: 480 },
      { qualityHeight: 360, width: 640, height: 360 },
      { qualityHeight: 240, width: 426, height: 240 },
      { qualityHeight: 144, width: 256, height: 144 },
    ]);
  });

  it("classifies letterboxed masters by display long edge, not frame height", () => {
    // A 4K scope feature stores a 1604px frame height; the height-threshold
    // ladder used to cap it at 720p and never produce a 1080p file.
    expect(classifyQualityHeight({ width: 3840, height: 1604 })).toBe(2160);
    // The top rung keeps the source's real shape rather than being stretched
    // up to the nominal class: a 2.39:1 master stays 2.39:1.
    expect(
      buildRenditionRequirements({ width: 3840, height: 1604, rotation: 0 }),
    ).toEqual([
      { qualityHeight: 2160, width: 3840, height: 1604 },
      { qualityHeight: 1440, width: 2560, height: 1070 },
      { qualityHeight: 1080, width: 1920, height: 802 },
      { qualityHeight: 720, width: 1280, height: 534 },
      { qualityHeight: 480, width: 854, height: 356 },
      { qualityHeight: 360, width: 640, height: 268 },
      { qualityHeight: 240, width: 426, height: 178 },
      { qualityHeight: 144, width: 256, height: 106 },
    ]);

    expect(classifyQualityHeight({ width: 1920, height: 816 })).toBe(1080);
    expect(
      buildRenditionRequirements({ width: 1920, height: 816, rotation: 0 }),
    ).toEqual([
      { qualityHeight: 1080, width: 1920, height: 816 },
      { qualityHeight: 720, width: 1280, height: 544 },
      { qualityHeight: 480, width: 854, height: 362 },
      { qualityHeight: 360, width: 640, height: 272 },
      { qualityHeight: 240, width: 426, height: 182 },
      { qualityHeight: 144, width: 256, height: 108 },
    ]);
  });

  it("does not upscale", () => {
    // A 480p source gets its own class and the rungs below it, and nothing
    // above: there are no extra pixels to invent.
    const fromSmallSource = buildRenditionRequirements({
      width: 854,
      height: 480,
      rotation: 0,
    });
    expect(fromSmallSource[0]).toEqual({
      qualityHeight: 480,
      width: 854,
      height: 480,
    });
    expect(fromSmallSource.every((rung) => rung.qualityHeight <= 480)).toBe(
      true,
    );
    expect(fromSmallSource.every((rung) => rung.width <= 854)).toBe(true);
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
      { qualityHeight: 2160, width: 2160, height: 3840 },
      { qualityHeight: 1440, width: 1440, height: 2560 },
      { qualityHeight: 1080, width: 1080, height: 1920 },
      { qualityHeight: 720, width: 720, height: 1280 },
      { qualityHeight: 480, width: 480, height: 854 },
      { qualityHeight: 360, width: 360, height: 640 },
      { qualityHeight: 240, width: 240, height: 426 },
      { qualityHeight: 144, width: 144, height: 256 },
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
