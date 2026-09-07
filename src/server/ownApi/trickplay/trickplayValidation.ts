import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { TrickplayLayout } from "./trickplayLayout";
import {
  isFilesystemSidecar,
  isInsideDirectory,
  spriteFileName,
} from "./trickplayStorage";

/**
 * Proving that what FFmpeg left behind is a usable set of sheets.
 *
 * A trickplay row is a promise to the seek bar: this many sheets exist, each of
 * this geometry, and tile *n* is at this offset inside sheet *m*. Nothing
 * checked that promise before — the row was written because the process exited
 * zero — and a truncated sheet, a missing final sheet or a sheet of the wrong
 * size all reach the viewer as a scrub bar showing the wrong frame or no frame
 * at all. So the bytes are read before the row is written, and the row is
 * written to describe the bytes rather than the plan.
 */

export class TrickplayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrickplayValidationError";
  }
}

export interface ValidatedTrickplayOutput {
  /** Sheets actually present, always numbered `0 … spriteCount - 1`. */
  spriteCount: number;
  /** Tiles the published set can actually address. */
  thumbnailCount: number;
  totalBytes: number;
}

const JPEG_START_OF_IMAGE = 0xffd8;
/** Start-of-frame markers. Everything else in this range is not a frame header. */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export interface JpegDimensions {
  width: number;
  height: number;
}

/**
 * The frame size a JPEG declares, read from its own header.
 *
 * Only enough of the file is walked to reach the first start-of-frame marker,
 * which is a few hundred bytes into a sheet that may be several megabytes. A
 * file whose header does not parse is not a JPEG this can vouch for, and it
 * returns null rather than a guess.
 */
export function readJpegDimensions(buffer: Buffer): JpegDimensions | null {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== JPEG_START_OF_IMAGE) {
    return null;
  }
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1] as number;
    // Padding between segments is legal and carries no length of its own.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers: no payload, so no length field to skip.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > buffer.length) return null;
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

async function readHeader(filePath: string, bytes: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface ValidateOptions {
  /**
   * The root every sprite must resolve beneath. Normally the staging directory
   * itself; the check exists so a symlink inside it cannot make validation
   * vouch for bytes that live somewhere else entirely.
   */
  containmentRoot?: string;
}

/**
 * Reads `directory` and returns what it actually holds, or throws.
 *
 * Fewer sheets than the layout predicted is accepted and *reported*: FFmpeg
 * samples a real duration, and a file whose container over-declares its length
 * by a few seconds legitimately yields one sheet less. The caller writes the
 * returned counts to the database, so the row still describes the disk. More
 * sheets than predicted is not accepted — that means the geometry the row would
 * carry does not describe this output at all.
 */
export async function validateTrickplayOutput(
  directory: string,
  layout: TrickplayLayout,
  { containmentRoot = directory }: ValidateOptions = {},
): Promise<ValidatedTrickplayOutput> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    throw new TrickplayValidationError(
      "The generated trickplay directory is missing.",
    );
  }

  const expectedWidth = layout.columns * layout.tileWidth;
  const expectedHeight = layout.rows * layout.tileHeight;
  const perSheet = layout.columns * layout.rows;

  /*
   * What the encoder wrote, with what the filesystem wrote alongside it set
   * aside first. See `isFilesystemSidecar` — on the exFAT volume this library
   * lives on, every sheet arrives with a `._` twin nobody asked for, and
   * counting those as output made every generation fail this check.
   */
  const written = entries.filter((name) => !isFilesystemSidecar(name));
  const sprites = written.filter((name) => /^sprite_\d+\.jpg$/.test(name));
  if (sprites.length !== written.length) {
    throw new TrickplayValidationError(
      "The generated trickplay directory holds files that are not sheets.",
    );
  }
  if (sprites.length === 0) {
    throw new TrickplayValidationError("No trickplay sheets were generated.");
  }
  if (sprites.length > layout.spriteCount) {
    throw new TrickplayValidationError(
      "More trickplay sheets were generated than the layout describes.",
    );
  }

  let totalBytes = 0;
  for (let index = 0; index < sprites.length; index += 1) {
    // Numbering is checked by construction: sheet `index` must exist for every
    // index below the count, which leaves no room for a gap.
    const spritePath = path.join(directory, spriteFileName(index));
    if (!isInsideDirectory(containmentRoot, spritePath)) {
      throw new TrickplayValidationError(
        "A trickplay sheet resolved outside its own directory.",
      );
    }

    const stats = await stat(spritePath).catch(() => null);
    if (!stats) {
      throw new TrickplayValidationError(
        `Trickplay sheet ${index} is missing; the sheets are not consecutive.`,
      );
    }
    if (!stats.isFile()) {
      throw new TrickplayValidationError(
        `Trickplay sheet ${index} is not a regular file.`,
      );
    }
    if (stats.size === 0) {
      throw new TrickplayValidationError(`Trickplay sheet ${index} is empty.`);
    }
    totalBytes += stats.size;

    const header = await readHeader(spritePath, 65_536);
    const dimensions = readJpegDimensions(header);
    if (!dimensions) {
      throw new TrickplayValidationError(
        `Trickplay sheet ${index} is not a readable JPEG.`,
      );
    }
    if (dimensions.width !== expectedWidth) {
      throw new TrickplayValidationError(
        `Trickplay sheet ${index} is ${dimensions.width}px wide; the layout needs ${expectedWidth}px.`,
      );
    }
    /*
     * Height is checked as a whole number of tile rows rather than as an exact
     * match. The tiler pads a partial final sheet to the full grid, but a build
     * that trims it instead is still a sheet the tile arithmetic can address —
     * a height that is not a multiple of the tile height is not.
     */
    if (
      dimensions.height <= 0 ||
      dimensions.height > expectedHeight ||
      dimensions.height % layout.tileHeight !== 0
    ) {
      throw new TrickplayValidationError(
        `Trickplay sheet ${index} is ${dimensions.height}px tall, which is not a whole number of ${layout.tileHeight}px tile rows.`,
      );
    }
  }

  return {
    spriteCount: sprites.length,
    // The row must never promise a tile that no sheet holds.
    thumbnailCount: Math.min(layout.thumbnailCount, sprites.length * perSheet),
    totalBytes,
  };
}
