import { describe, expect, it } from "vitest";
import {
  buildTrickplayLayout,
  locateTrickplayTile,
  tilesInSprite,
} from "./trickplayLayout";

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;

describe("buildTrickplayLayout", () => {
  it("derives tile height from the source aspect ratio", () => {
    const layout = buildTrickplayLayout({
      durationMs: TWO_HOURS_MS,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });

    expect(layout.tileWidth).toBe(320);
    expect(layout.tileHeight).toBe(180);
  });

  it("keeps tile height even, because encoders reject odd dimensions", () => {
    const layout = buildTrickplayLayout({
      durationMs: TWO_HOURS_MS,
      sourceWidth: 1920,
      sourceHeight: 803,
      tileWidth: 320,
    });

    expect(layout.tileHeight % 2).toBe(0);
  });

  it("counts thumbnails and sheets for the whole runtime", () => {
    const layout = buildTrickplayLayout({
      durationMs: TWO_HOURS_MS,
      sourceWidth: 1920,
      sourceHeight: 1080,
      intervalMs: 10_000,
      columns: 10,
      rows: 10,
    });

    expect(layout.thumbnailCount).toBe(720);
    expect(layout.spriteCount).toBe(8);
  });

  it("always produces at least one thumbnail for a very short file", () => {
    const layout = buildTrickplayLayout({
      durationMs: 500,
      sourceWidth: 640,
      sourceHeight: 360,
    });

    expect(layout.thumbnailCount).toBe(1);
    expect(layout.spriteCount).toBe(1);
  });

  it("refuses to build a layout without a probed duration or frame size", () => {
    expect(() =>
      buildTrickplayLayout({
        durationMs: 0,
        sourceWidth: 1920,
        sourceHeight: 1080,
      }),
    ).toThrow(/probed duration/);
    expect(() =>
      buildTrickplayLayout({
        durationMs: TWO_HOURS_MS,
        sourceWidth: 0,
        sourceHeight: 0,
      }),
    ).toThrow(/probed duration/);
  });
});

describe("locateTrickplayTile", () => {
  const layout = buildTrickplayLayout({
    durationMs: TWO_HOURS_MS,
    sourceWidth: 1920,
    sourceHeight: 1080,
  });

  it("maps the start of playback to the first tile", () => {
    expect(locateTrickplayTile(layout, 0)).toMatchObject({
      spriteIndex: 0,
      column: 0,
      row: 0,
      x: 0,
      y: 0,
    });
  });

  it("advances one tile per interval across a row", () => {
    expect(locateTrickplayTile(layout, 25_000)).toMatchObject({
      spriteIndex: 0,
      column: 2,
      row: 0,
      x: 640,
      y: 0,
    });
  });

  it("wraps to the next row after a full row of tiles", () => {
    expect(locateTrickplayTile(layout, 100_000)).toMatchObject({
      spriteIndex: 0,
      column: 0,
      row: 1,
      y: 180,
    });
  });

  it("moves to the next sheet after a full sheet of tiles", () => {
    // 100 tiles per sheet at 10s each: the 101st tile starts at 1000s.
    expect(locateTrickplayTile(layout, 1_000_000)).toMatchObject({
      spriteIndex: 1,
      column: 0,
      row: 0,
    });
  });

  it("clamps a position past the end to the last tile", () => {
    const beyond = locateTrickplayTile(layout, TWO_HOURS_MS * 2);
    expect(beyond.spriteIndex).toBe(layout.spriteCount - 1);
    expect(beyond.spriteIndex).toBeLessThan(layout.spriteCount);
  });

  it("clamps a negative position to the first tile", () => {
    expect(locateTrickplayTile(layout, -5_000).spriteIndex).toBe(0);
  });
});

describe("tilesInSprite", () => {
  it("reports a full sheet for every sheet but the last", () => {
    const layout = buildTrickplayLayout({
      durationMs: TWO_HOURS_MS,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });

    expect(tilesInSprite(layout, 0)).toBe(100);
    expect(tilesInSprite(layout, 6)).toBe(100);
    expect(tilesInSprite(layout, 7)).toBe(20);
  });

  it("reports nothing for a sheet beyond the end", () => {
    const layout = buildTrickplayLayout({
      durationMs: 60_000,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(tilesInSprite(layout, 5)).toBe(0);
  });
});
