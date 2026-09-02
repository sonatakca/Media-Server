import { describe, expect, it } from "vitest";
import {
  adjustLastSampleDuration,
  patchFragment,
  readFragmentTiming,
  readInitSegment,
  walkBoxes,
} from "./fragments";

/** Builds a box with a four-byte size and a four-character type. */
function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

function fullBox(type: string, version: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt8(version, 0);
  return box(type, Buffer.concat([head, payload]));
}

function u32(...values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeUInt32BE(value, index * 4));
  return buffer;
}

function initSegment(timescale: number, handler = "vide"): Buffer {
  const mdhd = fullBox("mdhd", 0, u32(0, 0, timescale, 0));
  const hdlr = fullBox(
    "hdlr",
    0,
    Buffer.concat([u32(0), Buffer.from(handler, "latin1"), u32(0, 0, 0)]),
  );
  const mdia = box("mdia", Buffer.concat([mdhd, hdlr]));
  const trak = box("trak", mdia);
  const moov = box("moov", trak);
  return Buffer.concat([box("ftyp", Buffer.from("isom", "latin1")), moov]);
}

const TRUN_DATA_OFFSET = 0x000001;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;

/**
 * A fragment shaped the way FFmpeg's fMP4 HLS muxer writes one: a segment
 * index, then `moof` and `mdat`.
 */
function fragment({
  sequence,
  baseMediaDecodeTime,
  sampleDurations,
  tfdtVersion = 0,
  withSidx = true,
  sidxVersion = 0,
}: {
  sequence: number;
  baseMediaDecodeTime: number;
  sampleDurations: number[];
  tfdtVersion?: 0 | 1;
  withSidx?: boolean;
  sidxVersion?: 0 | 1;
}): Buffer {
  const mfhd = fullBox("mfhd", 0, u32(sequence));
  const tfhd = fullBox("tfhd", 0, u32(1));
  const tfdtPayload =
    tfdtVersion === 1
      ? (() => {
          const value = Buffer.alloc(8);
          value.writeBigUInt64BE(BigInt(baseMediaDecodeTime));
          return value;
        })()
      : u32(baseMediaDecodeTime);
  const tfdt = fullBox("tfdt", tfdtVersion, tfdtPayload);

  const flags = TRUN_DATA_OFFSET | TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE;
  const records = Buffer.concat(
    sampleDurations.map((duration) => u32(duration, 100)),
  );
  const trunHead = Buffer.alloc(4);
  trunHead.writeUInt32BE(flags, 0);
  // version/flags, sample_count, data_offset, then one record per sample.
  const trun = box(
    "trun",
    Buffer.concat([trunHead, u32(sampleDurations.length, 0), records]),
  );

  const traf = box("traf", Buffer.concat([tfhd, tfdt, trun]));
  const moof = box("moof", Buffer.concat([mfhd, traf]));
  const mdat = box("mdat", Buffer.alloc(sampleDurations.length * 100));

  if (!withSidx) return Buffer.concat([moof, mdat]);

  const sidxPayload =
    sidxVersion === 1
      ? (() => {
          const value = Buffer.alloc(16);
          value.writeBigUInt64BE(BigInt(baseMediaDecodeTime), 0);
          return Buffer.concat([u32(1, 24_000), value, u32(0, 0)]);
        })()
      : Buffer.concat([u32(1, 24_000, baseMediaDecodeTime, 0), u32(0, 0)]);
  const sidx = fullBox("sidx", sidxVersion, sidxPayload);
  return Buffer.concat([sidx, moof, mdat]);
}

function sidxEarliestPresentationTime(buffer: Buffer): number | undefined {
  let value: number | undefined;
  walkBoxes(buffer, (candidate) => {
    if (candidate.type !== "sidx") return;
    const version = buffer[candidate.payload]!;
    value =
      version === 1
        ? Number(buffer.readBigUInt64BE(candidate.payload + 12))
        : buffer.readUInt32BE(candidate.payload + 12);
  });
  return value;
}

describe("readInitSegment", () => {
  it("reads the timescale and handler assembly depends on", () => {
    expect(readInitSegment(initSegment(24_000))).toEqual({
      mediaTimescale: 24_000,
      handler: "vide",
    });
  });

  it("refuses an initialisation segment with no usable timescale", () => {
    expect(() => readInitSegment(initSegment(0))).toThrow(/media timescale/);
  });
});

describe("readFragmentTiming", () => {
  it("sums the sample durations the track runs declare", () => {
    const timing = readFragmentTiming(
      fragment({
        sequence: 1,
        baseMediaDecodeTime: 48_048,
        sampleDurations: [1001, 1001, 1001],
      }),
    );
    expect(timing).toEqual({
      baseMediaDecodeTime: 48_048,
      sampleDurationTicks: 3003,
      sampleCount: 3,
    });
  });

  it("reports nothing for bytes that are not a fragment", () => {
    expect(readFragmentTiming(Buffer.alloc(64))).toBeNull();
  });
});

describe("patchFragment", () => {
  it("moves the fragment onto the global timeline", () => {
    const raw = fragment({
      sequence: 1,
      baseMediaDecodeTime: 48_048,
      sampleDurations: [1001, 1001],
    });
    const { buffer, result } = patchFragment(raw, {
      offsetTicks: 432_432,
      sequenceNumber: 7,
    });
    expect(result.localBaseMediaDecodeTime).toBe(48_048);
    expect(result.globalBaseMediaDecodeTime).toBe(480_480);
    expect(readFragmentTiming(buffer)!.baseMediaDecodeTime).toBe(480_480);
  });

  it("moves the segment index too, because FFmpeg reads that in preference", () => {
    const raw = fragment({
      sequence: 1,
      baseMediaDecodeTime: 48_048,
      sampleDurations: [1001],
    });
    const { buffer } = patchFragment(raw, { offsetTicks: 432_432 });
    expect(sidxEarliestPresentationTime(buffer)).toBe(480_480);
  });

  it("moves a 64-bit segment index as well", () => {
    const raw = fragment({
      sequence: 1,
      baseMediaDecodeTime: 48_048,
      sampleDurations: [1001],
      sidxVersion: 1,
    });
    const { buffer } = patchFragment(raw, { offsetTicks: 432_432 });
    expect(sidxEarliestPresentationTime(buffer)).toBe(480_480);
  });

  it("drops a segment index it cannot express rather than truncating it", () => {
    const raw = fragment({
      sequence: 1,
      baseMediaDecodeTime: 1000,
      sampleDurations: [1001],
    });
    const { buffer } = patchFragment(raw, { offsetTicks: 0xffffffff });
    expect(sidxEarliestPresentationTime(buffer)).toBeUndefined();
    // The fragment itself still carries the right decode time, in a box wide
    // enough to hold it.
    expect(readFragmentTiming(buffer)!.baseMediaDecodeTime).toBe(
      0xffffffff + 1000,
    );
  });

  it("widens a 32-bit decode time that no longer fits", () => {
    const raw = fragment({
      sequence: 1,
      baseMediaDecodeTime: 4_000_000_000,
      sampleDurations: [1001],
      withSidx: false,
    });
    const { buffer, result } = patchFragment(raw, {
      offsetTicks: 1_000_000_000,
    });
    expect(result.globalBaseMediaDecodeTime).toBe(5_000_000_000);
    expect(readFragmentTiming(buffer)!.baseMediaDecodeTime).toBe(5_000_000_000);
    // The box grew, so everything that measured from it had to move with it.
    expect(buffer.length).toBe(raw.length + 4);
  });

  it("renumbers the fragment so the assembled file counts from one", () => {
    const raw = fragment({
      sequence: 4,
      baseMediaDecodeTime: 0,
      sampleDurations: [1001],
    });
    const { buffer } = patchFragment(raw, {
      offsetTicks: 0,
      sequenceNumber: 12,
    });
    let sequence: number | undefined;
    walkBoxes(buffer, (candidate) => {
      if (candidate.type === "mfhd") {
        sequence = buffer.readUInt32BE(candidate.payload + 4);
      }
    });
    expect(sequence).toBe(12);
  });

  it("refuses bytes that carry no decode time at all", () => {
    expect(() => patchFragment(Buffer.alloc(32), { offsetTicks: 0 })).toThrow(
      /no base media decode time/,
    );
  });
});

describe("adjustLastSampleDuration", () => {
  it("closes a seam by lengthening the final sample", () => {
    const raw = fragment({
      sequence: 1,
      baseMediaDecodeTime: 0,
      sampleDurations: [1001, 1001],
    });
    expect(adjustLastSampleDuration(raw, 20)).toBe(true);
    expect(readFragmentTiming(raw)!.sampleDurationTicks).toBe(2022);
  });

  it("closes a seam by shortening it", () => {
    const raw = fragment({
      sequence: 1,
      baseMediaDecodeTime: 0,
      sampleDurations: [1001, 1001],
    });
    expect(adjustLastSampleDuration(raw, -20)).toBe(true);
    expect(readFragmentTiming(raw)!.sampleDurationTicks).toBe(1982);
  });

  it("refuses an adjustment that would leave a sample with no duration", () => {
    const raw = fragment({
      sequence: 1,
      baseMediaDecodeTime: 0,
      sampleDurations: [1001],
    });
    expect(adjustLastSampleDuration(raw, -1001)).toBe(false);
  });

  it("does nothing when there is nothing to close", () => {
    const raw = fragment({
      sequence: 1,
      baseMediaDecodeTime: 0,
      sampleDurations: [1001],
    });
    const before = Buffer.from(raw);
    expect(adjustLastSampleDuration(raw, 0)).toBe(true);
    expect(raw.equals(before)).toBe(true);
  });
});

/**
 * A fragment whose track run carries per-sample durations *and* whose segment
 * index carries a real reference.
 *
 * FFmpeg's constant-rate output has neither — `fragments.real.integration.test`
 * proves that — so this shape exists only to exercise the seam adjustment on
 * material that could reach it. The index matters because it records the
 * subsegment's length a second time, and FFmpeg's demuxer prefers the index:
 * an adjustment that moved the samples and left the index alone would produce
 * the same class of silent wrongness as the `earliest_presentation_time` trap.
 */
function fragmentWithIndexedDurations(sampleDurations: number[]): Buffer {
  const mfhd = fullBox("mfhd", 0, u32(1));
  const tfhd = fullBox("tfhd", 0, u32(1));
  const tfdt = fullBox("tfdt", 0, u32(0));
  const flags = TRUN_DATA_OFFSET | TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE;
  const trunHead = Buffer.alloc(4);
  trunHead.writeUInt32BE(flags, 0);
  const trun = box(
    "trun",
    Buffer.concat([
      trunHead,
      u32(sampleDurations.length, 0),
      Buffer.concat(sampleDurations.map((duration) => u32(duration, 100))),
    ]),
  );
  const traf = box("traf", Buffer.concat([tfhd, tfdt, trun]));
  const moof = box("moof", Buffer.concat([mfhd, traf]));
  const mdat = box("mdat", Buffer.alloc(sampleDurations.length * 100));
  const total = sampleDurations.reduce((sum, value) => sum + value, 0);
  // reference_ID, timescale, EPT, first_offset, reserved+count, then one
  // reference: {referenced_size, subsegment_duration, SAP}.
  const reserved = Buffer.alloc(4);
  reserved.writeUInt16BE(0, 0);
  reserved.writeUInt16BE(1, 2);
  const sidx = fullBox(
    "sidx",
    0,
    Buffer.concat([
      u32(1, 24_000, 0, 0),
      reserved,
      u32(moof.length + mdat.length, total, 0x9000_0000),
    ]),
  );
  return Buffer.concat([sidx, moof, mdat]);
}

function subsegmentDuration(buffer: Buffer): number | undefined {
  let value: number | undefined;
  walkBoxes(buffer, (candidate) => {
    if (candidate.type !== "sidx") return;
    const version = buffer[candidate.payload]!;
    const cursor = candidate.payload + 12 + (version === 1 ? 16 : 8) + 4;
    value = buffer.readUInt32BE(cursor + 4);
  });
  return value;
}

describe("keeping the segment index in step with an adjusted seam", () => {
  it("moves the index's subsegment duration with the sample it lengthened", () => {
    const fragment = fragmentWithIndexedDurations([1000, 1000, 1000]);
    expect(subsegmentDuration(fragment)).toBe(3000);
    expect(readFragmentTiming(fragment)!.sampleDurationTicks).toBe(3000);

    expect(adjustLastSampleDuration(fragment, 40)).toBe(true);

    // Both records of the same fact moved together.
    expect(readFragmentTiming(fragment)!.sampleDurationTicks).toBe(3040);
    expect(subsegmentDuration(fragment)).toBe(3040);
  });

  it("moves it back down when the seam is shortened", () => {
    const fragment = fragmentWithIndexedDurations([1000, 1000, 1000]);
    expect(adjustLastSampleDuration(fragment, -40)).toBe(true);
    expect(readFragmentTiming(fragment)!.sampleDurationTicks).toBe(2960);
    expect(subsegmentDuration(fragment)).toBe(2960);
  });

  it("leaves both alone when it refuses the adjustment", () => {
    const fragment = fragmentWithIndexedDurations([1000, 1000, 500]);
    expect(adjustLastSampleDuration(fragment, -500)).toBe(false);
    expect(readFragmentTiming(fragment)!.sampleDurationTicks).toBe(2500);
    expect(subsegmentDuration(fragment)).toBe(2500);
  });
});
