/**
 * Final assembly, without a video encoder.
 *
 * This is the step the whole architecture is judged on. Five hours of
 * checkpointed encoding followed by another full transcode would be worse than
 * no checkpointing at all, so assembly never decodes a frame and never invokes
 * FFmpeg. It copies bytes.
 *
 * That is possible because of two properties the epoch encoder deliberately
 * arranges. Every epoch is muxed with its own timeline starting at zero, which
 * makes each rendition's initialisation segment byte-identical across epochs —
 * checked here rather than assumed — so one initialisation serves the whole
 * title. And every epoch knows the exact source presentation time of its first
 * frame, so moving its fragments onto the global timeline is one addition to
 * each `tfdt` rather than a re-timestamping pass.
 *
 * What comes out is a single-file byte-range CMAF rendition indistinguishable
 * from one a single uninterrupted encode would have produced, with no
 * discontinuity tag, no second initialisation segment, and no seam a player has
 * to be told about.
 */

import { createWriteStream } from "node:fs";
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseMediaPlaylist } from "../playlist";
import { ADAPTIVE_MEDIA_FILE, ADAPTIVE_PLAYLIST_FILE } from "../profile";
import type { EpochPlan } from "./plan";
import { timestampToTicks } from "./sourceTimeline";
import {
  adjustLastSampleDuration,
  patchFragment,
  readFragmentTiming,
} from "./fragments";
import {
  completedEpochPath,
  type EpochCheckpointManifest,
} from "./checkpoints";

export interface AssembledRendition {
  id: string;
  mediaPath: string;
  playlistPath: string;
  segmentCount: number;
  durationSeconds: number;
  fileSizeBytes: number;
  /** Seams closed by adjusting the final sample of an epoch, for the log. */
  seamsClosed: number;
  /** Gaps left in place because the source itself has them. */
  sourceGaps: number;
}

export interface AssembleVideoInput {
  checkpointRoot: string;
  plan: EpochPlan;
  /** Manifests of the epochs to join, in plan order. */
  manifests: readonly EpochCheckpointManifest[];
  /** Rendition ids to assemble. */
  renditionIds: readonly string[];
  /** Where the finished package is staged. */
  targetRoot: string;
  /** Directory inside the staging root, e.g. `video`. */
  targetDirectory: string;
}

interface SegmentPlacement {
  offset: number;
  length: number;
  decodeTicks: number;
  endTicks: number;
  sampleCount: number;
}

/**
 * How far a seam may be nudged before it is treated as real.
 *
 * The muxer has to invent a duration for the last sample of every epoch,
 * because it never sees the frame that follows. Its guess is the previous
 * sample's duration, which is right for constant-rate material and can be a
 * frame out on variable-rate material. Closing a discrepancy of a frame or so
 * makes the join exact; a larger one is a gap the source genuinely contains —
 * a capture that dropped frames — and inventing playback time to fill it would
 * put the picture out of step with the sound.
 */
const SEAM_TOLERANCE_SAMPLES = 1.5;

export async function assembleVideoRenditions({
  checkpointRoot,
  plan,
  manifests,
  renditionIds,
  targetRoot,
  targetDirectory,
}: AssembleVideoInput): Promise<AssembledRendition[]> {
  if (manifests.length === 0) {
    throw new Error("Assembly needs at least one completed epoch.");
  }

  const assembled: AssembledRendition[] = [];

  for (const renditionId of renditionIds) {
    const outputDirectory = path.join(targetRoot, targetDirectory, renditionId);
    await mkdir(outputDirectory, { recursive: true });
    const mediaFile = path.join(outputDirectory, ADAPTIVE_MEDIA_FILE);

    const records = manifests.map((manifest) => {
      const record = manifest.renditions.find(
        (entry) => entry.id === renditionId,
      );
      if (!record) {
        throw new Error(
          `Epoch ${manifest.epochIndex} has no ${renditionId} rendition, so the title cannot be assembled.`,
        );
      }
      return { manifest, record };
    });

    const timescale = records[0]!.record.mediaTimescale;
    const initDigest = records[0]!.record.initDigest;
    for (const { manifest, record } of records) {
      if (record.mediaTimescale !== timescale) {
        throw new Error(
          `Epoch ${manifest.epochIndex} wrote ${renditionId} on a ${record.mediaTimescale} timescale where epoch 0 used ${timescale}; the epochs cannot be joined.`,
        );
      }
      if (record.initDigest !== initDigest) {
        throw new Error(
          `Epoch ${manifest.epochIndex} wrote a different ${renditionId} initialisation segment from epoch 0; the epochs cannot be joined.`,
        );
      }
    }

    const stream = createWriteStream(mediaFile);
    const write = (chunk: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        stream.write(chunk, (error) => (error ? reject(error) : resolve()));
      });

    const placements: SegmentPlacement[] = [];
    let cursor = 0;
    let sequence = 1;
    let seamsClosed = 0;
    let sourceGaps = 0;
    let initLength = 0;

    /*
     * One fragment is always held back.
     *
     * The muxer has to invent a duration for the last sample of every epoch,
     * because it never sees the frame that follows. Holding the previous
     * fragment until the next one's decode time is known is what lets that
     * guess be corrected in the media itself rather than papered over in the
     * playlist, so the assembled file is exactly contiguous where the source
     * is and keeps a genuine gap where the source has one.
     */
    let pending: { buffer: Buffer; placement: SegmentPlacement } | undefined;

    const flushPending = async (
      nextDecodeTicks: number | undefined,
    ): Promise<void> => {
      if (!pending) return;
      if (nextDecodeTicks !== undefined) {
        const gap = nextDecodeTicks - pending.placement.endTicks;
        if (gap !== 0) {
          const typical =
            pending.placement.sampleCount > 0
              ? (pending.placement.endTicks - pending.placement.decodeTicks) /
                pending.placement.sampleCount
              : 0;
          const tolerance = Math.ceil(typical * SEAM_TOLERANCE_SAMPLES);
          if (typical > 0 && Math.abs(gap) <= tolerance) {
            if (adjustLastSampleDuration(pending.buffer, gap)) {
              pending.placement.endTicks = nextDecodeTicks;
              seamsClosed += 1;
            }
          } else {
            // A gap of many frames is one the source itself contains — a
            // capture that dropped them — and inventing playback time to fill
            // it would put the picture out of step with the sound.
            sourceGaps += 1;
          }
        }
      }
      pending.placement.offset = cursor;
      await write(pending.buffer);
      cursor += pending.buffer.length;
      placements.push(pending.placement);
      pending = undefined;
    };

    try {
      for (const [epochOrdinal, { manifest, record }] of records.entries()) {
        const epochDirectory = completedEpochPath(
          checkpointRoot,
          manifest.epochIndex,
        );
        const mediaPath = path.join(
          epochDirectory,
          ...record.mediaPath.split("/"),
        );
        const playlist = parseMediaPlaylist(
          await readFile(
            path.join(epochDirectory, ...record.playlistPath.split("/")),
            "utf8",
          ),
        );
        const handle = await open(mediaPath, "r");
        try {
          if (epochOrdinal === 0) {
            const init = await readAt(
              handle,
              playlist.map.byteRange.offset,
              playlist.map.byteRange.length,
            );
            await write(init);
            initLength = init.length;
            cursor = init.length;
          }

          const planEntry = plan.epochs[manifest.epochIndex];
          if (!planEntry) {
            throw new Error(
              `Epoch ${manifest.epochIndex} is not in the plan being assembled.`,
            );
          }
          const offsetTicks = timestampToTicks(planEntry.start, timescale);

          for (const segment of playlist.segments) {
            const raw = await readAt(
              handle,
              segment.byteRange.offset,
              segment.byteRange.length,
            );
            const { buffer, result } = patchFragment(raw, {
              offsetTicks,
              sequenceNumber: sequence,
            });
            sequence += 1;
            const timing = readFragmentTiming(buffer);

            await flushPending(result.globalBaseMediaDecodeTime);
            pending = {
              buffer,
              placement: {
                offset: cursor,
                length: buffer.length,
                decodeTicks: result.globalBaseMediaDecodeTime,
                endTicks:
                  result.globalBaseMediaDecodeTime + result.sampleDurationTicks,
                sampleCount: timing?.sampleCount ?? 0,
              },
            };
          }
        } finally {
          await handle.close();
        }
      }
      await flushPending(undefined);
    } finally {
      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) =>
          error ? reject(error) : resolve(),
        );
      });
    }

    /*
     * Advertised durations come from the decode times that are actually in the
     * file, not from the per-epoch playlists. Copying those would carry each
     * epoch's last-segment guess into the final playlist and leave the
     * advertised duration disagreeing with the media by a frame per join. The
     * final segment keeps its own measured length, because nothing follows it
     * to measure against.
     */
    for (let index = 0; index < placements.length - 1; index += 1) {
      placements[index]!.endTicks = Math.max(
        placements[index]!.decodeTicks + 1,
        placements[index + 1]!.decodeTicks,
      );
    }

    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      /*
       * Rounded rather than ceilinged, which is what FFmpeg's own muxer writes
       * and therefore what every playlist this library already contains says.
       * A two-second ladder reads `2`, and an assembled title is
       * indistinguishable from one a single encode produced.
       */
      `#EXT-X-TARGETDURATION:${Math.max(
        1,
        Math.round(
          Math.max(
            ...placements.map(
              (placement) =>
                (placement.endTicks - placement.decodeTicks) / timescale,
            ),
          ),
        ),
      )}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      `#EXT-X-MAP:URI="${ADAPTIVE_MEDIA_FILE}",BYTERANGE="${initLength}@0"`,
    ];
    for (const placement of placements) {
      const duration = (placement.endTicks - placement.decodeTicks) / timescale;
      lines.push(
        `#EXTINF:${duration.toFixed(6)},`,
        `#EXT-X-BYTERANGE:${placement.length}@${placement.offset}`,
        ADAPTIVE_MEDIA_FILE,
      );
    }
    lines.push("#EXT-X-ENDLIST", "");
    await writeFile(
      path.join(outputDirectory, ADAPTIVE_PLAYLIST_FILE),
      lines.join("\n"),
      "utf8",
    );

    const last = placements[placements.length - 1]!;
    const first = placements[0]!;
    assembled.push({
      id: renditionId,
      mediaPath: `${targetDirectory}/${renditionId}/${ADAPTIVE_MEDIA_FILE}`,
      playlistPath: `${targetDirectory}/${renditionId}/${ADAPTIVE_PLAYLIST_FILE}`,
      segmentCount: placements.length,
      durationSeconds: (last.endTicks - first.decodeTicks) / timescale,
      fileSizeBytes: cursor,
      seamsClosed,
      sourceGaps,
    });
  }

  return assembled;
}

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  if (bytesRead !== length) {
    throw new Error(
      `A checkpoint media file is shorter than its playlist claims: wanted ${length} bytes at ${offset}, read ${bytesRead}.`,
    );
  }
  return buffer;
}

/**
 * Copies an already-complete stage — audio, subtitles — into the staging root.
 *
 * These are produced once for the whole title rather than per epoch, so there
 * is nothing to join: the files are moved across as they are. Kept here beside
 * the video assembler so "how does a finished package get built" has one
 * answer.
 */
export async function copyStageDirectory(
  from: string,
  to: string,
): Promise<number> {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) bytes += (await stat(full)).size;
    }
  };
  await walk(to);
  return bytes;
}
