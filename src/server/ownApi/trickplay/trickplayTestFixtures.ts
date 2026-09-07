import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spriteFileName } from "./trickplayStorage";

/**
 * Sheets a test can write without an FFmpeg.
 *
 * Generation now reads its own output back before it publishes it, so a fake
 * that writes nothing no longer exercises the path being tested. These are real
 * JPEGs in the only sense that matters here: a header a decoder would accept,
 * declaring the frame size the layout asked for.
 */

/**
 * The smallest JPEG that declares a size.
 *
 * SOI, a JFIF APP0 so the file looks like what it claims to be, an SOF0 frame
 * header carrying the dimensions, then EOI. Nothing decodes to a picture, and
 * nothing here needs one — the validator reads the frame header and the file
 * size and stops.
 */
export function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof0 = Buffer.alloc(19);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(17, 2); // segment length
  sof0.writeUInt8(8, 4); // sample precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0.writeUInt8(3, 9); // three components
  sof0.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 10);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof0,
    Buffer.from([0xff, 0xd9]),
  ]);
}

export interface WriteSheetsOptions {
  directory: string;
  count: number;
  width: number;
  height: number;
}

/** Writes `sprite_0 … sprite_{count-1}` into `directory`. */
export async function writeTrickplaySheets({
  directory,
  count,
  width,
  height,
}: WriteSheetsOptions): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await writeFile(
      path.join(directory, spriteFileName(index)),
      jpegBytes(width, height),
    );
  }
}

/**
 * The directory an FFmpeg argument list would have written into.
 *
 * The output pattern is the last argument and carries the muxer's `%d`; the
 * directory holding it is where the sheets go.
 */
export function outputDirectoryFromArgs(args: string[]): string {
  const pattern = args[args.length - 1] ?? "";
  return path.dirname(pattern);
}
