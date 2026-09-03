/**
 * The small amount of ISO base media file format this build has to understand.
 *
 * Final assembly is a byte copy, not a transcode and not even a remux through
 * FFmpeg, so the only structure that has to be rewritten is the handful of
 * fields that say *where on the timeline* a fragment sits. Every epoch is muxed
 * with its own timeline starting at zero — that is what makes the epochs'
 * initialisation segments byte-identical and therefore interchangeable — and
 * assembly moves each fragment onto the global timeline by adding one offset to
 * its `tfdt`.
 *
 * Deliberately not a general MP4 library. It walks boxes, edits four fields and
 * refuses anything it does not recognise as the shape FFmpeg's fMP4 HLS muxer
 * writes, because guessing at an unfamiliar layout is how a silent corruption
 * ships.
 */

import { createHash } from "node:crypto";

const CONTAINER_BOXES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "moof",
  "traf",
  "mvex",
  "edts",
]);

export interface BoxVisit {
  type: string;
  /** Offset of the box header within the buffer. */
  start: number;
  /** Offset of the first payload byte, after the size/type (and largesize). */
  payload: number;
  /** Offset one past the last byte of the box. */
  end: number;
}

/**
 * Walks the box tree, calling back for every box including containers.
 *
 * Returning `false` from the visitor skips descending into that container.
 */
export function walkBoxes(
  buffer: Buffer,
  visit: (box: BoxVisit) => boolean | void,
  start = 0,
  end = buffer.length,
): void {
  let position = start;
  while (position + 8 <= end) {
    let size = buffer.readUInt32BE(position);
    const type = buffer.toString("latin1", position + 4, position + 8);
    let header = 8;
    if (size === 1) {
      if (position + 16 > end) return;
      size = Number(buffer.readBigUInt64BE(position + 8));
      header = 16;
    } else if (size === 0) {
      size = end - position;
    }
    if (size < header || position + size > end) return;
    const box: BoxVisit = {
      type,
      start: position,
      payload: position + header,
      end: position + size,
    };
    const descend = visit(box);
    if (descend !== false && CONTAINER_BOXES.has(type)) {
      walkBoxes(buffer, visit, box.payload, box.end);
    }
    position += size;
  }
}

export interface InitSegmentSummary {
  /** Media timescale of the single track, from `mdhd`. */
  mediaTimescale: number;
  /** `handler_type` of the track: `vide` or `soun`. */
  handler: string;
}

/**
 * Reads the two facts assembly needs from an initialisation segment.
 *
 * The timescale is what an offset in seconds has to be converted into, and the
 * handler is checked so a video rendition's fragments are never patched with an
 * audio track's timescale after a directory mix-up.
 */
export function readInitSegment(buffer: Buffer): InitSegmentSummary {
  let mediaTimescale: number | undefined;
  let handler: string | undefined;
  walkBoxes(buffer, (box) => {
    if (box.type === "mdhd") {
      const version = buffer[box.payload]!;
      mediaTimescale =
        version === 1
          ? buffer.readUInt32BE(box.payload + 20)
          : buffer.readUInt32BE(box.payload + 12);
    } else if (box.type === "hdlr") {
      handler = buffer.toString("latin1", box.payload + 8, box.payload + 12);
    }
  });
  if (mediaTimescale === undefined || !(mediaTimescale > 0)) {
    throw new Error(
      "The initialisation segment carries no usable media timescale.",
    );
  }
  return { mediaTimescale, handler: handler ?? "unknown" };
}

export interface FragmentTiming {
  /** Decode time of the first sample in the fragment, in media timescale. */
  baseMediaDecodeTime: number;
  /** Sum of the sample durations the fragment's track runs declare. */
  sampleDurationTicks: number;
  sampleCount: number;
}

const TRUN_DATA_OFFSET_PRESENT = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT = 0x000004;
const TRUN_SAMPLE_DURATION_PRESENT = 0x000100;
const TRUN_SAMPLE_SIZE_PRESENT = 0x000200;
const TRUN_SAMPLE_FLAGS_PRESENT = 0x000400;
const TRUN_SAMPLE_COMPOSITION_OFFSET_PRESENT = 0x000800;

const TFHD_BASE_DATA_OFFSET_PRESENT = 0x000001;
const TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION_PRESENT = 0x000008;

interface TrunLayout {
  box: BoxVisit;
  flags: number;
  sampleCount: number;
  /** Offset of the first sample record. */
  recordsAt: number;
  recordSize: number;
}

function trunLayout(buffer: Buffer, box: BoxVisit): TrunLayout {
  const flags = buffer.readUInt32BE(box.payload) & 0x00ffffff;
  const sampleCount = buffer.readUInt32BE(box.payload + 4);
  let cursor = box.payload + 8;
  if (flags & TRUN_DATA_OFFSET_PRESENT) cursor += 4;
  if (flags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT) cursor += 4;
  const recordSize =
    (flags & TRUN_SAMPLE_DURATION_PRESENT ? 4 : 0) +
    (flags & TRUN_SAMPLE_SIZE_PRESENT ? 4 : 0) +
    (flags & TRUN_SAMPLE_FLAGS_PRESENT ? 4 : 0) +
    (flags & TRUN_SAMPLE_COMPOSITION_OFFSET_PRESENT ? 4 : 0);
  return { box, flags, sampleCount, recordsAt: cursor, recordSize };
}

/**
 * How long a fragment lasts and where it starts, without decoding anything.
 *
 * The durations come from the track runs when they carry them and from the
 * track fragment header's default otherwise, which is the pair of places the
 * format allows them to be.
 */
export function readFragmentTiming(buffer: Buffer): FragmentTiming | null {
  let baseMediaDecodeTime: number | undefined;
  let defaultSampleDuration = 0;
  let sampleDurationTicks = 0;
  let sampleCount = 0;

  walkBoxes(buffer, (box) => {
    if (box.type === "tfdt") {
      const version = buffer[box.payload]!;
      baseMediaDecodeTime =
        version === 1
          ? Number(buffer.readBigUInt64BE(box.payload + 4))
          : buffer.readUInt32BE(box.payload + 4);
    } else if (box.type === "tfhd") {
      const flags = buffer.readUInt32BE(box.payload) & 0x00ffffff;
      let cursor = box.payload + 8;
      if (flags & TFHD_BASE_DATA_OFFSET_PRESENT) cursor += 8;
      if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT) cursor += 4;
      if (flags & TFHD_DEFAULT_SAMPLE_DURATION_PRESENT) {
        defaultSampleDuration = buffer.readUInt32BE(cursor);
      }
    } else if (box.type === "trun") {
      const layout = trunLayout(buffer, box);
      sampleCount += layout.sampleCount;
      if (layout.flags & TRUN_SAMPLE_DURATION_PRESENT) {
        for (let index = 0; index < layout.sampleCount; index += 1) {
          sampleDurationTicks += buffer.readUInt32BE(
            layout.recordsAt + index * layout.recordSize,
          );
        }
      } else {
        sampleDurationTicks += defaultSampleDuration * layout.sampleCount;
      }
    }
  });

  if (baseMediaDecodeTime === undefined) return null;
  return { baseMediaDecodeTime, sampleDurationTicks, sampleCount };
}

export interface PatchFragmentResult {
  /** Decode time the fragment carried before it was moved. */
  localBaseMediaDecodeTime: number;
  /** Decode time it carries now. */
  globalBaseMediaDecodeTime: number;
  sampleDurationTicks: number;
}

/**
 * Moves one fragment onto the global timeline, in place.
 *
 * `tfdt` is widened to a 64-bit box when the shifted value no longer fits in
 * 32: a two-and-a-half hour title at a 90 kHz timescale passes four billion
 * ticks well before the end, and silently truncating there would put the last
 * half of a film at the start of the timeline. Widening changes the box size,
 * so the fragment buffer is rewritten rather than edited when it happens.
 */
export function patchFragment(
  fragment: Buffer,
  {
    offsetTicks,
    sequenceNumber,
  }: { offsetTicks: number; sequenceNumber?: number },
): { buffer: Buffer; result: PatchFragmentResult } {
  fragment = shiftSegmentIndexes(fragment, offsetTicks);

  let local: number | undefined;
  let widenAt: { box: BoxVisit; value: number } | undefined;

  walkBoxes(fragment, (box) => {
    if (box.type === "mfhd" && sequenceNumber !== undefined) {
      fragment.writeUInt32BE(sequenceNumber >>> 0, box.payload + 4);
    } else if (box.type === "tfdt") {
      const version = fragment[box.payload]!;
      if (version === 1) {
        const value = Number(fragment.readBigUInt64BE(box.payload + 4));
        local ??= value;
        fragment.writeBigUInt64BE(BigInt(value + offsetTicks), box.payload + 4);
      } else {
        const value = fragment.readUInt32BE(box.payload + 4);
        local ??= value;
        const shifted = value + offsetTicks;
        if (shifted > 0xffffffff) widenAt = { box, value: shifted };
        else fragment.writeUInt32BE(shifted, box.payload + 4);
      }
    }
  });

  if (local === undefined) {
    throw new Error("A media fragment carries no base media decode time.");
  }

  let buffer = fragment;
  if (widenAt) {
    buffer = widenTfdt(fragment, widenAt.box, widenAt.value);
  }

  const timing = readFragmentTiming(buffer);
  return {
    buffer,
    result: {
      localBaseMediaDecodeTime: local,
      globalBaseMediaDecodeTime: local + offsetTicks,
      sampleDurationTicks: timing?.sampleDurationTicks ?? 0,
    },
  };
}

/**
 * Moves each segment index onto the global timeline, or drops it.
 *
 * FFmpeg writes a `sidx` in front of every fMP4 segment, and its
 * `earliest_presentation_time` is the second place a fragment records where it
 * sits — the first being `tfdt`. Leaving it at the epoch-local value is not a
 * cosmetic inconsistency: FFmpeg's own demuxer prefers the index, so an
 * assembled title whose indexes all start again at zero reports the duration of
 * its last epoch and nothing else, while its frames are perfectly correct. That
 * is the worst kind of defect, because everything that inspects the media
 * agrees it is fine except the one number the validator reads.
 *
 * A 32-bit index that cannot hold the shifted value is dropped rather than
 * truncated. HLS addresses these segments by byte range from the playlist, so
 * the index is redundant for delivery, and a wrong index is far worse than none.
 */
function shiftSegmentIndexes(fragment: Buffer, offsetTicks: number): Buffer {
  const drop: BoxVisit[] = [];
  walkBoxes(fragment, (box) => {
    if (box.type !== "sidx") return;
    const version = fragment[box.payload]!;
    if (version === 1) {
      const value = fragment.readBigUInt64BE(box.payload + 12);
      fragment.writeBigUInt64BE(value + BigInt(offsetTicks), box.payload + 12);
      return;
    }
    const value = fragment.readUInt32BE(box.payload + 12);
    const shifted = value + offsetTicks;
    if (shifted > 0xffffffff) drop.push(box);
    else fragment.writeUInt32BE(shifted, box.payload + 12);
  });
  if (drop.length === 0) return fragment;

  const kept: Buffer[] = [];
  let cursor = 0;
  for (const box of drop) {
    kept.push(fragment.subarray(cursor, box.start));
    cursor = box.end;
  }
  kept.push(fragment.subarray(cursor));
  return Buffer.concat(kept);
}

/**
 * Rewrites a 32-bit `tfdt` as its 64-bit form.
 *
 * The box grows by four bytes, so every enclosing box's size and the `trun`
 * data offsets that point past it have to move with it. Both are handled here
 * rather than left to the caller, because a fragment whose `trun` data offset
 * is four bytes short decodes as noise.
 */
function widenTfdt(fragment: Buffer, box: BoxVisit, value: number): Buffer {
  const grown = Buffer.alloc(fragment.length + 4);
  fragment.copy(grown, 0, 0, box.start);
  grown.writeUInt32BE(20, box.start);
  grown.write("tfdt", box.start + 4, "latin1");
  grown.writeUInt8(1, box.start + 8);
  grown.writeUIntBE(0, box.start + 9, 3);
  grown.writeBigUInt64BE(BigInt(value), box.start + 12);
  fragment.copy(grown, box.start + 20, box.end);

  // Every container that held the old box is now four bytes longer.
  walkBoxes(grown, (candidate) => {
    if (!CONTAINER_BOXES.has(candidate.type)) return;
    if (candidate.start < box.start && candidate.end > box.start) {
      const header = candidate.payload - candidate.start;
      if (header === 8) {
        grown.writeUInt32BE(
          candidate.end - candidate.start + 4,
          candidate.start,
        );
      }
    }
  });

  // `trun` data offsets are measured from the start of the enclosing `moof`, so
  // growing a box inside it moves every sample.
  walkBoxes(grown, (candidate) => {
    if (candidate.type !== "trun") return;
    const flags = grown.readUInt32BE(candidate.payload) & 0x00ffffff;
    if (!(flags & TRUN_DATA_OFFSET_PRESENT)) return;
    const current = grown.readInt32BE(candidate.payload + 8);
    grown.writeInt32BE(current + 4, candidate.payload + 8);
  });

  return grown;
}

/**
 * Trims or extends the last sample of a fragment so the epoch ends exactly
 * where the next one begins.
 *
 * Only ever used to close a sub-frame seam. A source with a genuine gap in its
 * presentation timeline — a variable-rate capture that dropped frames — must
 * keep that gap, so an adjustment larger than the tolerance is refused and the
 * seam is reported instead of being papered over.
 */
export function adjustLastSampleDuration(
  fragment: Buffer,
  deltaTicks: number,
): boolean {
  if (deltaTicks === 0) return true;
  let last: { at: number; value: number } | undefined;
  walkBoxes(fragment, (box) => {
    if (box.type !== "trun") return;
    const layout = trunLayout(fragment, box);
    if (layout.sampleCount === 0) return;
    /*
     * FFmpeg's fMP4 HLS muxer writes constant-rate output with the duration in
     * the track fragment header's default rather than per sample, and a `trun`
     * with no duration records has nothing here to adjust. Reported rather than
     * worked around: lengthening the header default would move *every* sample
     * in the fragment, and adding a duration array would change box sizes and
     * every offset that points past them. The caller is told the seam could not
     * be closed so it can say so, instead of assuming it was.
     */
    if (!(layout.flags & TRUN_SAMPLE_DURATION_PRESENT)) return;
    const at = layout.recordsAt + (layout.sampleCount - 1) * layout.recordSize;
    last = { at, value: fragment.readUInt32BE(at) };
  });
  if (!last) return false;
  const adjusted = last.value + deltaTicks;
  if (adjusted <= 0) return false;
  fragment.writeUInt32BE(adjusted, last.at);
  /*
   * The segment index records the same duration a second time, and FFmpeg's own
   * demuxer prefers the index — the same trap that made an assembled title
   * report the length of its last epoch alone. Changing a sample without
   * changing the index would leave the two disagreeing by the seam.
   */
  shiftSubsegmentDurations(fragment, deltaTicks);
  return true;
}

/**
 * Keeps a segment index's `subsegment_duration` in step with the media.
 *
 * Only the last reference is adjusted: the seam is at the end of the fragment,
 * so that is the subsegment whose length changed.
 */
function shiftSubsegmentDurations(fragment: Buffer, deltaTicks: number): void {
  walkBoxes(fragment, (box) => {
    if (box.type !== "sidx") return;
    const version = fragment[box.payload]!;
    // reference_ID, timescale, then the two timestamps, then reserved + count.
    let cursor = box.payload + 12 + (version === 1 ? 16 : 8);
    const referenceCount = fragment.readUInt16BE(cursor + 2);
    if (referenceCount === 0) return;
    cursor += 4;
    const durationAt = cursor + (referenceCount - 1) * 12 + 4;
    if (durationAt + 4 > box.end) return;
    const adjusted = fragment.readUInt32BE(durationAt) + deltaTicks;
    if (adjusted <= 0) return;
    fragment.writeUInt32BE(adjusted, durationAt);
  });
}

/**
 * What actually has to match for two epochs to be joined.
 *
 * Assembly writes the *first* epoch's initialisation segment and then copies
 * every other epoch's fragments in after it, so the rest are discarded. A
 * fragment is therefore compatible when it decodes correctly under that
 * initialisation — which is decided by the decoder configuration record, the
 * sample entry's format and dimensions, the colour signalling and the media
 * timescale, and by nothing else in the box tree.
 *
 * The distinction matters because the check used to be a digest of the whole
 * initialisation segment, and on a real HDR title that is stricter than the
 * truth. A replacement epoch generated from `lavfi` produced a byte-identical
 * `hvcC` — the same VideoToolbox encoder, the same profile, level and GOP — and
 * still failed, because the film's own epochs carry two HDR10 static metadata
 * boxes the generator has nothing to put in (`mdcv`, the mastering display
 * colour volume, and `clli`, the content light level) along with different
 * container tags in `udta`. None of those are read when decoding a fragment,
 * and all of them belong to the initialisation that assembly keeps: the
 * published title carries the film's real mastering metadata either way.
 */
export interface EpochJoinKey {
  mediaTimescale: number;
  /** `hvc1`, `avc1`, … — the sample entry's four-character format. */
  sampleFormat: string;
  width: number;
  height: number;
  /** Digest over the decoder configuration record and colour signalling. */
  configDigest: string;
}

/** Sample-entry children that decide how a fragment decodes and is displayed. */
const JOIN_RELEVANT_BOXES = new Set(["hvcC", "avcC", "av1C", "vpcC", "colr"]);

/** Bytes of a visual sample entry before its child boxes begin. */
const VISUAL_SAMPLE_ENTRY_HEADER = 78;

/**
 * Reads the joinability key from an initialisation segment.
 *
 * Deliberately narrow, like the rest of this file: it understands the shape
 * FFmpeg's fMP4 muxer writes and refuses anything else rather than guessing.
 */
export function readEpochJoinKey(buffer: Buffer): EpochJoinKey {
  const { mediaTimescale } = readInitSegment(buffer);
  let sampleFormat: string | undefined;
  let width = 0;
  let height = 0;
  const parts: Buffer[] = [];

  walkBoxes(buffer, (box) => {
    if (box.type !== "stsd") return;
    /*
     * `stsd` is a full box whose payload is version/flags, an entry count and
     * then the entries themselves. Only the first is read: a rendition this
     * pipeline writes carries exactly one sample entry.
     */
    const entry = box.payload + 8;
    if (entry + 8 + VISUAL_SAMPLE_ENTRY_HEADER > box.end) return;
    sampleFormat = buffer.toString("latin1", entry + 4, entry + 8);
    const size = buffer.readUInt32BE(entry);
    width = buffer.readUInt16BE(entry + 8 + 24);
    height = buffer.readUInt16BE(entry + 8 + 26);
    walkBoxes(
      buffer,
      (child) => {
        if (!JOIN_RELEVANT_BOXES.has(child.type)) return;
        parts.push(
          Buffer.concat([
            Buffer.from(child.type, "latin1"),
            buffer.subarray(child.payload, child.end),
          ]),
        );
      },
      entry + 8 + VISUAL_SAMPLE_ENTRY_HEADER,
      Math.min(entry + size, box.end),
    );
  });

  if (sampleFormat === undefined || parts.length === 0) {
    throw new Error(
      "The initialisation segment carries no readable sample description.",
    );
  }
  return {
    mediaTimescale,
    sampleFormat,
    width,
    height,
    configDigest: createHash("sha256")
      .update(Buffer.concat(parts))
      .digest("hex"),
  };
}

/** Whether two epochs' fragments may be joined under one initialisation. */
export function joinKeysMatch(
  left: EpochJoinKey,
  right: EpochJoinKey,
): boolean {
  return (
    left.mediaTimescale === right.mediaTimescale &&
    left.sampleFormat === right.sampleFormat &&
    left.width === right.width &&
    left.height === right.height &&
    left.configDigest === right.configDigest
  );
}

/** Names the first difference, for a message a person can act on. */
export function describeJoinMismatch(
  left: EpochJoinKey,
  right: EpochJoinKey,
): string | undefined {
  if (left.mediaTimescale !== right.mediaTimescale)
    return `a ${left.mediaTimescale} media timescale where the reference used ${right.mediaTimescale}`;
  if (left.sampleFormat !== right.sampleFormat)
    return `a ${left.sampleFormat} sample entry where the reference used ${right.sampleFormat}`;
  if (left.width !== right.width || left.height !== right.height)
    return `${left.width}x${left.height} where the reference used ${right.width}x${right.height}`;
  if (left.configDigest !== right.configDigest)
    return "a different decoder configuration from the reference";
  return undefined;
}
