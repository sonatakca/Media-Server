/**
 * The box rewriter, checked against bytes FFmpeg actually wrote.
 *
 * `fragments.test.ts` builds fragments by hand, which is the right way to reach
 * the edges — a 32-bit decode time that overflows, a segment index that cannot
 * be expressed — but a hand-built fragment is a fragment shaped the way *this
 * repository believes* FFmpeg writes them. That belief is the thing most worth
 * testing, because when it is wrong the rewriter edits fields that are not
 * there and silently leaves the ones that are.
 *
 * So this file encodes with the real muxer, at the real settings the packager
 * uses, and asserts against what comes out.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseMediaPlaylist } from "../playlist";
import {
  adjustLastSampleDuration,
  patchFragment,
  readFragmentTiming,
  walkBoxes,
} from "./fragments";

const run = promisify(execFile);

let workspace = "";
let media: Buffer | null = null;
let playlist: ReturnType<typeof parseMediaPlaylist> | null = null;

const TIMESCALE_OFFSET_TICKS = 7_207_200; // 300.3 s at 24 000 ticks/s.

beforeAll(async () => {
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    return;
  }
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-real-frag-"));
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=24000/1001:duration=12",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      // Exactly the key-frame policy the packager uses.
      "-force_key_frames",
      "expr:gte(t,n_forced*2)",
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_playlist_type",
      "vod",
      "-hls_segment_type",
      "fmp4",
      "-hls_flags",
      "single_file+independent_segments",
      "-hls_segment_filename",
      path.join(workspace, "media.m4s"),
      "-y",
      path.join(workspace, "playlist.m3u8"),
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  media = await readFile(path.join(workspace, "media.m4s"));
  playlist = parseMediaPlaylist(
    await readFile(path.join(workspace, "playlist.m3u8"), "utf8"),
  );
}, 120_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

function segment(index: number): Buffer {
  const entry = playlist!.segments[index]!;
  return media!.subarray(
    entry.byteRange.offset,
    entry.byteRange.offset + entry.byteRange.length,
  );
}

interface SidxView {
  version: number;
  earliestPresentationTime: number;
  referenceCount: number;
  referencedSize: number;
  subsegmentDuration: number;
}

function readSidx(buffer: Buffer): SidxView | null {
  let view: SidxView | null = null;
  walkBoxes(buffer, (box) => {
    if (box.type !== "sidx") return;
    const version = buffer[box.payload]!;
    let cursor = box.payload + 12;
    const earliest =
      version === 1
        ? Number(buffer.readBigUInt64BE(cursor))
        : buffer.readUInt32BE(cursor);
    cursor += version === 1 ? 16 : 8;
    const referenceCount = buffer.readUInt16BE(cursor + 2);
    cursor += 4;
    view = {
      version,
      earliestPresentationTime: earliest,
      referenceCount,
      referencedSize: buffer.readUInt32BE(cursor) & 0x7fffffff,
      subsegmentDuration: buffer.readUInt32BE(cursor + 4),
    };
  });
  return view;
}

function boxTypes(buffer: Buffer): string[] {
  const found: string[] = [];
  walkBoxes(buffer, (box) => {
    found.push(box.type);
  });
  return found;
}

function trunView(buffer: Buffer) {
  let view:
    | { flags: number; sampleCount: number; dataOffset?: number }
    | undefined;
  walkBoxes(buffer, (box) => {
    if (box.type !== "trun") return;
    const flags = buffer.readUInt32BE(box.payload) & 0x00ffffff;
    const sampleCount = buffer.readUInt32BE(box.payload + 4);
    view = {
      flags,
      sampleCount,
      ...(flags & 0x1
        ? { dataOffset: buffer.readInt32BE(box.payload + 8) }
        : {}),
    };
  });
  return view;
}

function tfdtVersion(buffer: Buffer): number | undefined {
  let version: number | undefined;
  walkBoxes(buffer, (box) => {
    if (box.type === "tfdt") version = buffer[box.payload]!;
  });
  return version;
}

function mfhdSequence(buffer: Buffer): number | undefined {
  let sequence: number | undefined;
  walkBoxes(buffer, (box) => {
    if (box.type === "mfhd") sequence = buffer.readUInt32BE(box.payload + 4);
  });
  return sequence;
}

function boxExtent(
  buffer: Buffer,
  type: string,
): { start: number; end: number } | undefined {
  let extent: { start: number; end: number } | undefined;
  walkBoxes(buffer, (box) => {
    if (box.type === type && !extent)
      extent = { start: box.start, end: box.end };
  });
  return extent;
}

describe("what FFmpeg's fMP4 HLS muxer actually writes", () => {
  /**
   * The shape the rewriter is built around, asserted rather than assumed.
   *
   * If a future FFmpeg changes any of these the rewriter's assumptions change
   * with them, and this test is where that is discovered — not in a title whose
   * second half plays at the wrong time.
   */
  it("writes sidx, then moof, then mdat, once per segment", () => {
    if (!media) return;
    expect(boxTypes(segment(0))).toEqual([
      "sidx",
      "moof",
      "mfhd",
      "traf",
      "tfhd",
      "tfdt",
      "trun",
      "mdat",
    ]);
  });

  it("writes a 64-bit tfdt, so the widening path is not reached in practice", () => {
    if (!media) return;
    for (let index = 0; index < playlist!.segments.length; index += 1) {
      expect(tfdtVersion(segment(index))).toBe(1);
    }
  });

  it("writes a 64-bit segment index carrying exactly one reference", () => {
    if (!media) return;
    const sidx = readSidx(segment(0))!;
    expect(sidx.version).toBe(1);
    expect(sidx.referenceCount).toBe(1);
  });

  /**
   * The index's `referenced_size` covers everything after the index itself.
   * Nothing in assembly may change the size of `moof` or `mdat`, because that
   * number is not recomputed.
   */
  it("sizes the index's reference to the moof and mdat that follow it", () => {
    if (!media) return;
    const bytes = segment(0);
    const sidx = readSidx(bytes)!;
    const sidxExtent = boxExtent(bytes, "sidx")!;
    expect(sidx.referencedSize).toBe(bytes.length - sidxExtent.end);
  });

  /**
   * The finding that matters most for the seam policy: constant-rate output
   * carries no per-sample durations at all, so there is no last sample duration
   * in the track run for the assembler to adjust.
   */
  it("carries sample sizes but not sample durations in the track run", () => {
    if (!media) return;
    const trun = trunView(segment(0))!;
    expect(trun.flags & 0x000200).toBeTruthy(); // sample sizes present
    expect(trun.flags & 0x000100).toBe(0); // sample durations absent
  });

  it("agrees between the index's subsegment duration and the fragment timing", () => {
    if (!media) return;
    const bytes = segment(0);
    expect(readSidx(bytes)!.subsegmentDuration).toBe(
      readFragmentTiming(bytes)!.sampleDurationTicks,
    );
  });
});

describe("patchFragment against real bytes", () => {
  it("moves tfdt and the segment index by exactly the same offset", () => {
    if (!media) return;
    const original = Buffer.from(segment(1));
    const beforeTfdt = readFragmentTiming(original)!.baseMediaDecodeTime;
    const beforeSidx = readSidx(original)!.earliestPresentationTime;

    const { buffer, result } = patchFragment(Buffer.from(original), {
      offsetTicks: TIMESCALE_OFFSET_TICKS,
      sequenceNumber: 42,
    });

    expect(result.localBaseMediaDecodeTime).toBe(beforeTfdt);
    expect(result.globalBaseMediaDecodeTime).toBe(
      beforeTfdt + TIMESCALE_OFFSET_TICKS,
    );
    expect(readFragmentTiming(buffer)!.baseMediaDecodeTime).toBe(
      beforeTfdt + TIMESCALE_OFFSET_TICKS,
    );
    expect(readSidx(buffer)!.earliestPresentationTime).toBe(
      beforeSidx + TIMESCALE_OFFSET_TICKS,
    );
  });

  it("renumbers the fragment without changing its length or any box size", () => {
    if (!media) return;
    const original = Buffer.from(segment(2));
    const { buffer } = patchFragment(Buffer.from(original), {
      offsetTicks: TIMESCALE_OFFSET_TICKS,
      sequenceNumber: 9,
    });
    expect(mfhdSequence(buffer)).toBe(9);
    // A 64-bit tfdt cannot be widened, so nothing may grow.
    expect(buffer.length).toBe(original.length);
    expect(boxExtent(buffer, "moof")).toEqual(boxExtent(original, "moof"));
    expect(boxExtent(buffer, "mdat")).toEqual(boxExtent(original, "mdat"));
  });

  it("leaves the track run's data offset and sample count alone", () => {
    if (!media) return;
    const original = Buffer.from(segment(2));
    const { buffer } = patchFragment(Buffer.from(original), {
      offsetTicks: TIMESCALE_OFFSET_TICKS,
      sequenceNumber: 9,
    });
    expect(trunView(buffer)).toEqual(trunView(original));
  });

  /**
   * The sample payload is the one thing assembly must never touch. Composition
   * offsets, B-frame ordering and every coded byte live in `mdat`, and they are
   * correct after a move precisely because nothing rewrites them.
   */
  it("copies every encoded byte of mdat unchanged", () => {
    if (!media) return;
    const original = Buffer.from(segment(3));
    const { buffer } = patchFragment(Buffer.from(original), {
      offsetTicks: TIMESCALE_OFFSET_TICKS,
      sequenceNumber: 3,
    });
    const extent = boxExtent(original, "mdat")!;
    expect(
      buffer
        .subarray(extent.start, extent.end)
        .equals(original.subarray(extent.start, extent.end)),
    ).toBe(true);
  });

  /**
   * The property the whole assembly rests on: after every fragment is moved by
   * its own epoch's offset, decode times run strictly forward across the joins.
   */
  it("produces strictly increasing decode times across two simulated epochs", () => {
    if (!media) return;
    const timing = readFragmentTiming(segment(0))!;
    const epochTicks = timing.sampleDurationTicks * 3;
    const decodeTimes: number[] = [];
    const sequences: number[] = [];
    let sequence = 1;
    for (const epoch of [0, 1]) {
      for (let index = 0; index < 3; index += 1) {
        const { buffer, result } = patchFragment(Buffer.from(segment(index)), {
          offsetTicks: epoch * epochTicks,
          sequenceNumber: sequence,
        });
        decodeTimes.push(result.globalBaseMediaDecodeTime);
        sequences.push(mfhdSequence(buffer)!);
        sequence += 1;
      }
    }
    for (let index = 1; index < decodeTimes.length; index += 1) {
      expect(decodeTimes[index]!).toBeGreaterThan(decodeTimes[index - 1]!);
    }
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

describe("closing a seam in real bytes", () => {
  /**
   * It cannot be done, and saying so is the point.
   *
   * The track run carries no per-sample durations, so there is no last sample
   * duration to lengthen. The function reports that rather than pretending, and
   * leaves the fragment untouched — which is what makes it safe for the
   * assembler to treat a refusal as "this seam stays as it is".
   */
  it("refuses, and changes nothing, when the run carries no sample durations", () => {
    if (!media) return;
    const original = Buffer.from(segment(1));
    const subject = Buffer.from(original);
    expect(adjustLastSampleDuration(subject, 100)).toBe(false);
    expect(subject.equals(original)).toBe(true);
  });

  it("still reports success for a request that asks for no change at all", () => {
    if (!media) return;
    expect(adjustLastSampleDuration(Buffer.from(segment(1)), 0)).toBe(true);
  });
});
