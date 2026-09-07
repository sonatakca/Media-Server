/**
 * Splitting one sampling pass into several that can run at the same time.
 *
 * Sampling is decode-bound and decodes everything: `fps=1/N` at the head of the
 * graph means the whole source is walked to keep one frame in a couple of
 * hundred. A single pass was measured at 11-16x realtime on a ten-core machine
 * while the volume it reads had 40 MB/s to give and the pass wanted 16 — so the
 * decoder, not the disk, was what the title was waiting for.
 *
 * A sheet is a whole number of tiles and a tile is a fixed slice of source
 * time, so the source divides on sheet boundaries with nothing left over. Each
 * segment therefore seeks to a boundary, samples its own sheets, and numbers
 * them from its own first index; the sheets that come out are byte-identical to
 * the ones a single pass writes, which is the property that makes this a
 * scheduling change rather than a picture change.
 *
 * Kept pure and separate from the service for the same reason `trickplayLayout`
 * is: the arithmetic that decides which sheet holds which second is the one
 * thing client and server must agree on exactly.
 */

import type { TrickplayLayout } from "./trickplayLayout";

export interface TrickplaySegment {
  /**
   * The sheet this segment writes first, zero-based.
   *
   * Passed to FFmpeg as `-start_number`, so the files a segment writes land in
   * the same numbering a single pass would have used.
   */
  firstSpriteIndex: number;
  /** Sheets this segment is responsible for. */
  spriteCount: number;
  /** Where in the source it starts sampling. */
  startSeconds: number;
  /**
   * How much source it reads, or undefined for "everything that is left".
   *
   * Only the last segment is open-ended, and deliberately so: a container that
   * over-declares its length by a few seconds should yield one tile fewer
   * rather than a truncated read, which is the same latitude
   * `validateTrickplayOutput` already allows.
   */
  durationSeconds?: number;
  /** Tiles this segment is expected to emit. */
  thumbnailCount: number;
}

/**
 * How many segments one title may be split into.
 *
 * Not the core count. Every segment is another reader on the volume holding the
 * source, and the measured ceiling there is what bounds this rather than the
 * CPU: one pass wants about 16 MB/s of a volume that gives 40, so a second
 * reader is nearly free and a fourth is not. Three is the point where the two
 * limits meet on the hardware this was measured on.
 */
export const MAX_TRICKPLAY_SEGMENTS = 3;

/**
 * Divides a layout into segments that can be sampled concurrently.
 *
 * Returns exactly one segment — covering the whole source, with no seek and no
 * duration limit — whenever the title is too short to divide or the caller asks
 * for one. That case is byte-for-byte the command this service has always run.
 */
export function planTrickplaySegments(
  layout: TrickplayLayout,
  maxSegments: number = MAX_TRICKPLAY_SEGMENTS,
): TrickplaySegment[] {
  const perSheet = layout.columns * layout.rows;
  const sheetSeconds = (perSheet * layout.intervalMs) / 1_000;
  const segmentCount = Math.max(
    1,
    Math.min(Math.floor(maxSegments) || 1, layout.spriteCount),
  );

  if (segmentCount === 1) {
    return [
      {
        firstSpriteIndex: 0,
        spriteCount: layout.spriteCount,
        startSeconds: 0,
        thumbnailCount: layout.thumbnailCount,
      },
    ];
  }

  /*
   * Sheets, not seconds, are what is dealt out: a segment that owned a
   * fractional sheet would have to hand a half-filled tile grid to the next
   * one, and there is no way to express that to the tiler.
   */
  const base = Math.floor(layout.spriteCount / segmentCount);
  const remainder = layout.spriteCount % segmentCount;

  const segments: TrickplaySegment[] = [];
  let firstSpriteIndex = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    const spriteCount = base + (index < remainder ? 1 : 0);
    const isLast = index === segmentCount - 1;
    const startSeconds = firstSpriteIndex * sheetSeconds;
    /*
     * The tail is whatever the layout has left rather than sheets times tiles:
     * the final sheet of a title is usually partial, and it is the only one
     * whose expected tile count is not the full grid.
     */
    const thumbnailCount = isLast
      ? layout.thumbnailCount - firstSpriteIndex * perSheet
      : spriteCount * perSheet;

    segments.push({
      firstSpriteIndex,
      spriteCount,
      startSeconds,
      ...(isLast ? {} : { durationSeconds: spriteCount * sheetSeconds }),
      thumbnailCount,
    });
    firstSpriteIndex += spriteCount;
  }

  return segments;
}
