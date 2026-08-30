import { describe, expect, it } from "vitest";
import {
  GENERATED_TITLE_DIRECTORIES,
  LADDER_QUALITY_CLASSES,
  audioFileStem,
  frameRateForClass,
  qualityLabel,
  safeFileStem,
  subtitleFileStem,
} from "./layout";

describe("the rung a frame rate is allowed on", () => {
  it("keeps a high frame rate at 720p and above", () => {
    expect(frameRateForClass(2160, 60)).toBe(60);
    expect(frameRateForClass(1080, 60)).toBe(60);
    expect(frameRateForClass(720, 60)).toBe(60);
  });

  /**
   * The small rungs exist because bandwidth is short. Doubling their frame
   * count spends that bandwidth on frames the viewer on that rung cannot see.
   */
  it("halves it below 720p", () => {
    expect(frameRateForClass(480, 60)).toBe(30);
    expect(frameRateForClass(360, 60)).toBe(30);
    expect(frameRateForClass(144, 60)).toBe(30);
  });

  it("never invents frames the source does not have", () => {
    expect(frameRateForClass(2160, 23.976)).toBeCloseTo(23.976);
    expect(frameRateForClass(240, 23.976)).toBeCloseTo(23.976);
    expect(frameRateForClass(1080, 25)).toBe(25);
  });

  it("recognises 50 Hz material as high frame rate rather than halving it", () => {
    expect(frameRateForClass(1080, 50)).toBe(50);
  });

  it("has nothing to say about a source with no known rate", () => {
    expect(frameRateForClass(1080, undefined)).toBeUndefined();
  });
});

describe("what a rung is called", () => {
  it("joins the frame rate to the height and separates HDR", () => {
    expect(
      qualityLabel({ qualityHeight: 2160, frameRate: 60, isHdr: true }),
    ).toBe("2160p60 HDR");
    expect(qualityLabel({ qualityHeight: 1080, frameRate: 60 })).toBe(
      "1080p60",
    );
    expect(qualityLabel({ qualityHeight: 480, frameRate: 30 })).toBe("480p");
  });

  it("says nothing about the rate for ordinary film material", () => {
    expect(qualityLabel({ qualityHeight: 1080, frameRate: 23.976 })).toBe(
      "1080p",
    );
  });

  it("marks HDR on a standard-rate rung too", () => {
    expect(
      qualityLabel({ qualityHeight: 2160, frameRate: 24, isHdr: true }),
    ).toBe("2160p HDR");
  });
});

describe("the ladder", () => {
  it("runs from 2160p down to 144p, largest first", () => {
    expect(LADDER_QUALITY_CLASSES[0]).toBe(2160);
    expect(LADDER_QUALITY_CLASSES.at(-1)).toBe(144);
    expect([...LADDER_QUALITY_CLASSES]).toEqual(
      [...LADDER_QUALITY_CLASSES].sort((a, b) => b - a),
    );
  });

  /**
   * The jump from 1080p to 2160p is four times the pixels; a link that cannot
   * hold the top rung should have somewhere to land other than 1080p.
   */
  it("includes 1440p between 1080p and 2160p", () => {
    expect(LADDER_QUALITY_CLASSES).toContain(1440);
    expect(LADDER_QUALITY_CLASSES.indexOf(1440)).toBe(
      LADDER_QUALITY_CLASSES.indexOf(2160) + 1,
    );
  });
});

describe("naming a track file", () => {
  it("names an audio track by its language", () => {
    expect(audioFileStem({ language: "eng", languageName: "English" })).toBe(
      "english",
    );
    expect(audioFileStem({ language: "tur", languageName: "Turkish" })).toBe(
      "turkish",
    );
  });

  it("marks the original-language track and commentary", () => {
    expect(audioFileStem({ languageName: "English", isOriginal: true })).toBe(
      "english (original)",
    );
    expect(audioFileStem({ languageName: "English", isCommentary: true })).toBe(
      "english (commentary)",
    );
  });

  it("keeps forced and hearing-impaired subtitles apart from the full track", () => {
    expect(subtitleFileStem({ languageName: "English" })).toBe("english");
    expect(subtitleFileStem({ languageName: "English", isForced: true })).toBe(
      "english (forced)",
    );
    expect(
      subtitleFileStem({ languageName: "Turkish", isHearingImpaired: true }),
    ).toBe("turkish (sdh)");
  });
});

describe("filesystem safety", () => {
  it("keeps the characters that make a name readable", () => {
    expect(safeFileStem("2160p60 HDR")).toBe("2160p60 HDR");
    expect(safeFileStem("english (original)")).toBe("english (original)");
    expect(safeFileStem("Director's Cut - Part 1")).toBe(
      "Director's Cut - Part 1",
    );
  });

  it("removes what a filesystem will not accept", () => {
    expect(safeFileStem('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(safeFileStem("trailing dot.")).toBe("trailing dot");
    expect(safeFileStem("   ")).toBe("untitled");
  });
});

describe("what the scanner must not walk into", () => {
  /**
   * Each of these holds real video files belonging to the title above it, so
   * without the exclusion a seven-rung ladder scans as seven more movies.
   */
  it("names every directory a title generates", () => {
    expect([...GENERATED_TITLE_DIRECTORIES].sort()).toEqual([
      "audio",
      "content",
      "subtitle",
      "video",
    ]);
  });
});
