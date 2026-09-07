import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTrickplayLayout } from "./trickplayLayout";
import { jpegBytes, writeTrickplaySheets } from "./trickplayTestFixtures";
import {
  readJpegDimensions,
  TrickplayValidationError,
  validateTrickplayOutput,
} from "./trickplayValidation";

const LAYOUT = buildTrickplayLayout({
  durationMs: 3_600_000,
  sourceWidth: 3840,
  sourceHeight: 2160,
});
const WIDTH = LAYOUT.columns * LAYOUT.tileWidth;
const HEIGHT = LAYOUT.rows * LAYOUT.tileHeight;

/**
 * A row is a promise the seek bar acts on without checking. These are the ways
 * that promise used to be able to be false.
 */
describe("validating what FFmpeg left behind", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "trickplay-validate-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("accepts a complete set and reports what it counted", async () => {
    await writeTrickplaySheets({
      directory,
      count: LAYOUT.spriteCount,
      width: WIDTH,
      height: HEIGHT,
    });

    const result = await validateTrickplayOutput(directory, LAYOUT);

    expect(result.spriteCount).toBe(LAYOUT.spriteCount);
    expect(result.thumbnailCount).toBe(LAYOUT.thumbnailCount);
    expect(result.totalBytes).toBeGreaterThan(0);
  });

  it("rejects an empty directory", async () => {
    await expect(validateTrickplayOutput(directory, LAYOUT)).rejects.toThrow(
      TrickplayValidationError,
    );
  });

  it("rejects a directory that is not there at all", async () => {
    await expect(
      validateTrickplayOutput(path.join(directory, "gone"), LAYOUT),
    ).rejects.toThrow(TrickplayValidationError);
  });

  it("rejects a zero-byte sheet", async () => {
    await writeTrickplaySheets({
      directory,
      count: 2,
      width: WIDTH,
      height: HEIGHT,
    });
    await writeFile(path.join(directory, "sprite_1.jpg"), Buffer.alloc(0));

    await expect(validateTrickplayOutput(directory, LAYOUT)).rejects.toThrow(
      /empty/,
    );
  });

  it("rejects a sheet that is not a JPEG", async () => {
    await writeFile(path.join(directory, "sprite_0.jpg"), "not a picture");

    await expect(validateTrickplayOutput(directory, LAYOUT)).rejects.toThrow(
      /readable JPEG/,
    );
  });

  /*
   * The tile arithmetic is pure geometry: a sheet of the wrong width puts every
   * tile in the wrong place, silently, for the whole film.
   */
  it("rejects a sheet whose width is not the one the layout computes offsets from", async () => {
    await writeFile(
      path.join(directory, "sprite_0.jpg"),
      jpegBytes(WIDTH - 8, HEIGHT),
    );

    await expect(validateTrickplayOutput(directory, LAYOUT)).rejects.toThrow(
      /wide/,
    );
  });

  it("rejects a sheet whose height is not a whole number of tile rows", async () => {
    await writeFile(
      path.join(directory, "sprite_0.jpg"),
      jpegBytes(WIDTH, LAYOUT.tileHeight * 2 + 3),
    );

    await expect(validateTrickplayOutput(directory, LAYOUT)).rejects.toThrow(
      /tile rows/,
    );
  });

  it("accepts a trimmed final sheet, which is still whole tile rows", async () => {
    await writeFile(
      path.join(directory, "sprite_0.jpg"),
      jpegBytes(WIDTH, HEIGHT),
    );
    await writeFile(
      path.join(directory, "sprite_1.jpg"),
      jpegBytes(WIDTH, LAYOUT.tileHeight * 3),
    );

    const result = await validateTrickplayOutput(directory, LAYOUT);

    expect(result.spriteCount).toBe(2);
  });

  it("rejects a gap in the numbering", async () => {
    await writeFile(
      path.join(directory, "sprite_0.jpg"),
      jpegBytes(WIDTH, HEIGHT),
    );
    await writeFile(
      path.join(directory, "sprite_5.jpg"),
      jpegBytes(WIDTH, HEIGHT),
    );

    await expect(validateTrickplayOutput(directory, LAYOUT)).rejects.toThrow(
      /consecutive/,
    );
  });

  it("rejects anything in the directory that is not a sheet", async () => {
    await writeTrickplaySheets({
      directory,
      count: 1,
      width: WIDTH,
      height: HEIGHT,
    });
    await writeFile(path.join(directory, "notes.txt"), "x");

    await expect(validateTrickplayOutput(directory, LAYOUT)).rejects.toThrow(
      /not sheets/,
    );
  });

  /*
   * The media volume is exFAT, which cannot hold an extended attribute, so
   * macOS writes `com.apple.provenance` into an AppleDouble sidecar instead:
   * every sheet FFmpeg produces arrives with a `._` twin. Counting those as
   * output failed every generation on the real installation and left all
   * twenty-three of the old sets unmigrated, so the rule is that a sidecar is
   * something the filesystem wrote, not something the encoder did.
   */
  it("accepts the AppleDouble sidecars an exFAT volume writes beside the sheets", async () => {
    await writeTrickplaySheets({
      directory,
      count: LAYOUT.spriteCount,
      width: WIDTH,
      height: HEIGHT,
    });
    for (let index = 0; index < LAYOUT.spriteCount; index += 1) {
      await writeFile(
        path.join(directory, `._sprite_${index}.jpg`),
        Buffer.alloc(4_096),
      );
    }
    await writeFile(path.join(directory, ".DS_Store"), "x");

    const result = await validateTrickplayOutput(directory, LAYOUT);

    // The sidecars are ignored, not counted: the row still describes sheets.
    expect(result.spriteCount).toBe(LAYOUT.spriteCount);
    expect(result.thumbnailCount).toBe(LAYOUT.thumbnailCount);
  });

  /*
   * The other half of that allowance. Ignoring two known filesystem names must
   * not become ignoring whatever happens to be there — this check exists to
   * notice output that is not what was asked for.
   */
  it("still rejects a stray file whose name a sidecar allowance does not cover", async () => {
    await writeTrickplaySheets({
      directory,
      count: 1,
      width: WIDTH,
      height: HEIGHT,
    });
    await writeFile(path.join(directory, "._notes.txt.bak"), "x");
    await writeFile(path.join(directory, "sprite_0.png"), "x");

    await expect(validateTrickplayOutput(directory, LAYOUT)).rejects.toThrow(
      /not sheets/,
    );
  });

  it("rejects a sheet that is a directory wearing the name", async () => {
    await mkdir(path.join(directory, "sprite_0.jpg"));

    await expect(validateTrickplayOutput(directory, LAYOUT)).rejects.toThrow(
      TrickplayValidationError,
    );
  });

  /*
   * Fewer sheets than predicted is legitimate — a container can over-declare
   * its duration by a few seconds — but the row must then describe the sheets
   * that exist rather than the ones that were planned.
   */
  it("accepts a short set and lowers the counts to match it", async () => {
    await writeTrickplaySheets({
      directory,
      count: 1,
      width: WIDTH,
      height: HEIGHT,
    });

    const result = await validateTrickplayOutput(directory, LAYOUT);

    expect(result.spriteCount).toBe(1);
    expect(result.thumbnailCount).toBe(LAYOUT.columns * LAYOUT.rows);
    expect(result.thumbnailCount).toBeLessThan(LAYOUT.thumbnailCount);
  });

  it("rejects more sheets than the layout describes", async () => {
    await writeTrickplaySheets({
      directory,
      count: LAYOUT.spriteCount + 1,
      width: WIDTH,
      height: HEIGHT,
    });

    await expect(validateTrickplayOutput(directory, LAYOUT)).rejects.toThrow(
      /More trickplay sheets/,
    );
  });
});

describe("reading a JPEG's own frame header", () => {
  it("reads the declared size", () => {
    expect(readJpegDimensions(jpegBytes(3200, 1800))).toEqual({
      width: 3200,
      height: 1800,
    });
  });

  it("returns null rather than a guess for anything that is not one", () => {
    expect(readJpegDimensions(Buffer.from("PNG\r\n"))).toBeNull();
    expect(readJpegDimensions(Buffer.alloc(0))).toBeNull();
    // A truncated file: the SOI is there and the frame header never arrives.
    expect(readJpegDimensions(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});
