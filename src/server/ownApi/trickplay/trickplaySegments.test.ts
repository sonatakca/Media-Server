import { describe, expect, it } from "vitest";
import { buildTrickplayLayout } from "./trickplayLayout";
import {
  MAX_TRICKPLAY_SEGMENTS,
  planTrickplaySegments,
} from "./trickplaySegments";

/** An hour at the defaults: 360 tiles, a hundred to a sheet, four sheets. */
const HOUR = buildTrickplayLayout({
  durationMs: 3_600_000,
  sourceWidth: 3840,
  sourceHeight: 2160,
});

describe("planTrickplaySegments", () => {
  it("covers every tile exactly once, in order", () => {
    const segments = planTrickplaySegments(HOUR);
    expect(
      segments.reduce((total, segment) => total + segment.thumbnailCount, 0),
    ).toBe(HOUR.thumbnailCount);
    expect(
      segments.reduce((total, segment) => total + segment.spriteCount, 0),
    ).toBe(HOUR.spriteCount);

    let expectedFirst = 0;
    for (const segment of segments) {
      expect(segment.firstSpriteIndex).toBe(expectedFirst);
      expectedFirst += segment.spriteCount;
    }
  });

  it("starts each segment on the sheet boundary the layout puts it at", () => {
    const perSheet = HOUR.columns * HOUR.rows;
    for (const segment of planTrickplaySegments(HOUR)) {
      expect(segment.startSeconds).toBe(
        (segment.firstSpriteIndex * perSheet * HOUR.intervalMs) / 1_000,
      );
    }
  });

  it("leaves only the last segment open-ended", () => {
    const segments = planTrickplaySegments(HOUR);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments.slice(0, -1)) {
      expect(segment.durationSeconds).toBeDefined();
    }
    expect(segments.at(-1)?.durationSeconds).toBeUndefined();
  });

  it("gives each non-final segment exactly the source its sheets cover", () => {
    const perSheet = HOUR.columns * HOUR.rows;
    for (const segment of planTrickplaySegments(HOUR).slice(0, -1)) {
      expect(segment.durationSeconds).toBe(
        (segment.spriteCount * perSheet * HOUR.intervalMs) / 1_000,
      );
      expect(segment.thumbnailCount).toBe(segment.spriteCount * perSheet);
    }
  });

  it("counts only the tiles a partial final sheet actually holds", () => {
    // 3,650s: 365 tiles, so the fourth sheet carries sixty-five of a hundred.
    const partial = buildTrickplayLayout({
      durationMs: 3_650_000,
      sourceWidth: 3840,
      sourceHeight: 2160,
    });
    const segments = planTrickplaySegments(partial, 2);
    expect(segments.at(-1)?.thumbnailCount).toBe(
      partial.thumbnailCount -
        (segments.at(-1)?.firstSpriteIndex ?? 0) *
          partial.columns *
          partial.rows,
    );
    expect(
      segments.reduce((total, segment) => total + segment.thumbnailCount, 0),
    ).toBe(partial.thumbnailCount);
  });

  it("is the single unseeked pass when the title has one sheet", () => {
    const short = buildTrickplayLayout({
      durationMs: 600_000,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(short.spriteCount).toBe(1);
    expect(planTrickplaySegments(short)).toEqual([
      {
        firstSpriteIndex: 0,
        spriteCount: 1,
        startSeconds: 0,
        thumbnailCount: short.thumbnailCount,
      },
    ]);
  });

  it("never plans more segments than there are sheets", () => {
    const twoSheets = buildTrickplayLayout({
      durationMs: 1_500_000,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(twoSheets.spriteCount).toBe(2);
    expect(planTrickplaySegments(twoSheets, 8)).toHaveLength(2);
  });

  it("treats a nonsensical segment count as one pass", () => {
    for (const count of [0, -3, Number.NaN]) {
      expect(planTrickplaySegments(HOUR, count)).toHaveLength(1);
    }
  });

  it("splits into the configured maximum when there are sheets to spare", () => {
    const long = buildTrickplayLayout({
      durationMs: 9_000_000,
      sourceWidth: 3840,
      sourceHeight: 1600,
    });
    expect(planTrickplaySegments(long)).toHaveLength(MAX_TRICKPLAY_SEGMENTS);
  });
});
