/**
 * Synthetic media for a stretch of source that cannot be read.
 *
 * The replacement is not "some black video". It has to be indistinguishable
 * from a real epoch to everything downstream: the same codec, the same profile
 * and level, the same pixel format, the same colour signalling, the same GOP,
 * the same segment grid, the same media timescale — and, above all, a
 * byte-identical initialisation segment for every rung, because assembly joins
 * epochs under one initialisation and refuses anything else.
 *
 * That is why nothing here builds an FFmpeg command of its own. The placeholder
 * goes through `buildAdaptivePackageFfmpegArgs`, the same function the real
 * epochs go through, with the source file swapped for a `lavfi` colour
 * generator and the epoch's exact planned length as the output duration.
 * Everything that decides how the bitstream looks is therefore shared code
 * rather than a parallel set of flags that could drift.
 *
 * The claim that this produces identical initialisation segments is not taken
 * on trust: the caller compares digests against a real epoch before the
 * placeholder is allowed to become a checkpoint.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { PauseController } from "../../processing/pauseController";
import type { RenditionHdrSignal, RenditionVideoEncoder } from "../../encoding";
import type { parseFfmpegProgressFields } from "../../progress";
import type { EncoderWatchdog } from "../../processExecution";
import {
  adaptiveOutputDirectories,
  buildAdaptivePackageFfmpegArgs,
  type AdaptiveVideoOutput,
} from "../encoding";

/**
 * Frame rates that are written as exact rationals rather than as decimals.
 *
 * 23.976 is not 24000/1001, and the difference decides the media timescale the
 * muxer chooses — which decides whether the placeholder can be joined to the
 * epochs around it at all. Anything not recognised here is emitted with enough
 * decimal places to land on the same timescale in practice, and the digest
 * check afterwards is what actually proves it did.
 */
const RATIONAL_FRAME_RATES: ReadonlyArray<{ value: number; text: string }> = [
  { value: 24000 / 1001, text: "24000/1001" },
  { value: 30000 / 1001, text: "30000/1001" },
  { value: 60000 / 1001, text: "60000/1001" },
  { value: 120000 / 1001, text: "120000/1001" },
  { value: 24, text: "24" },
  { value: 25, text: "25" },
  { value: 30, text: "30" },
  { value: 48, text: "48" },
  { value: 50, text: "50" },
  { value: 60, text: "60" },
  { value: 100, text: "100" },
  { value: 120, text: "120" },
];

/** The rate as `lavfi` should be told it, exactly where an exact form exists. */
export function formatFrameRateExpression(
  frameRate: number | undefined,
): string {
  if (!frameRate || !Number.isFinite(frameRate) || frameRate <= 0) return "25";
  const exact = RATIONAL_FRAME_RATES.find(
    (candidate) => Math.abs(candidate.value - frameRate) < 0.001,
  );
  if (exact) return exact.text;
  return String(Number(frameRate.toFixed(6)));
}

/**
 * The `lavfi` graph that stands in for the unreadable picture.
 *
 * Sized to the largest rung so every rung is produced by scaling down, which is
 * the same direction the real epochs scale in. The colour is black because a
 * viewer reaching a replaced interval should see nothing rather than a test
 * pattern claiming to be content; the fact that it was replaced is carried in
 * the job's warning, where it can be read rather than guessed at.
 */
export function placeholderVideoSource({
  videoOutputs,
  frameRate,
}: {
  videoOutputs: readonly AdaptiveVideoOutput[];
  frameRate?: number;
}): string {
  const width = Math.max(...videoOutputs.map((output) => output.width));
  const height = Math.max(...videoOutputs.map((output) => output.height));
  return `color=c=black:s=${width}x${height}:r=${formatFrameRateExpression(frameRate)}`;
}

export interface PlaceholderEpochEncodeRunner {
  (
    command: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      logPath: string;
      onProgress?: (
        progress: ReturnType<typeof parseFfmpegProgressFields>,
      ) => void;
      onStderr?: (chunk: string) => void;
      watchdog?: EncoderWatchdog;
      pauseController?: PauseController;
    },
  ): Promise<void>;
}

export interface GeneratePlaceholderEpochInput {
  /** The partial epoch workspace this writes into. */
  directory: string;
  videoOutputs: readonly AdaptiveVideoOutput[];
  encoder: RenditionVideoEncoder;
  hdr?: RenditionHdrSignal;
  /**
   * The rate the real epochs were encoded at.
   *
   * Prefer a rate measured from a finished epoch over the plan's ceiling: the
   * muxer's timescale follows it, and a timescale that differs by so much as a
   * factor makes the epoch unjoinable.
   */
  frameRate?: number;
  segmentSeconds: number;
  preset: string;
  softwareThreads?: number;
  filterComplexThreads?: number;
  /** Exactly the epoch's planned length. Never the partial output's length. */
  durationSeconds: number;
  ffmpegPath: string;
  logPath: string;
  runEncoder: PlaceholderEpochEncodeRunner;
  signal?: AbortSignal;
  pauseController?: PauseController;
  statsPeriodSeconds?: number;
  /**
   * Ends the generation if it stops producing.
   *
   * A replacement reads no source at all, so a stall here is a wedged encoder
   * rather than a bad platter — but it is still a process this system has to be
   * able to stop, and still a job that must not hang for ever.
   */
  watchdog?: EncoderWatchdog;
  onProgress?: (progress: ReturnType<typeof parseFfmpegProgressFields>) => void;
}

/**
 * The exact arguments a placeholder is encoded with.
 *
 * Separated from running them so a test can assert the shape — same encoder,
 * same segment length, the planned duration and nothing that seeks the source —
 * without spawning anything.
 */
export function buildPlaceholderEpochArgs({
  directory,
  videoOutputs,
  encoder,
  hdr,
  frameRate,
  segmentSeconds,
  preset,
  softwareThreads,
  filterComplexThreads,
  durationSeconds,
  statsPeriodSeconds,
}: Pick<
  GeneratePlaceholderEpochInput,
  | "directory"
  | "videoOutputs"
  | "encoder"
  | "hdr"
  | "frameRate"
  | "segmentSeconds"
  | "preset"
  | "softwareThreads"
  | "filterComplexThreads"
  | "durationSeconds"
  | "statsPeriodSeconds"
>): string[] {
  if (!(durationSeconds > 0)) {
    throw new Error(
      "A replacement epoch must be given the length the plan expected, which is never zero.",
    );
  }
  return buildAdaptivePackageFfmpegArgs({
    inputPath: placeholderVideoSource({
      videoOutputs,
      ...(frameRate === undefined ? {} : { frameRate }),
    }),
    inputFormat: "lavfi",
    // FFmpeg joins `%v` templates with forward slashes on every platform.
    outputRoot: directory.split(path.sep).join("/"),
    videoOutputs: [...videoOutputs],
    audioOutputs: [],
    encoder,
    ...(hdr ? { hdr } : {}),
    ...(frameRate === undefined ? {} : { frameRate }),
    segmentSeconds,
    preset,
    ...(softwareThreads === undefined ? {} : { softwareThreads }),
    ...(filterComplexThreads === undefined ? {} : { filterComplexThreads }),
    /*
     * No `startSeconds`. There is nothing to seek to, and — just as important —
     * the seek-preroll trim exists only to drop a frame the source hands over
     * with a negative timestamp. A generator produces no such frame, so asking
     * for the trim would change the filter graph and with it the bitstream.
     */
    durationSeconds,
    ...(statsPeriodSeconds === undefined ? {} : { statsPeriodSeconds }),
  });
}

/**
 * Writes one replacement epoch into a partial workspace.
 *
 * Produces every rung the ladder needs, in the same single process, exactly as
 * a real epoch does — so the rungs cut on the same instants and the epoch
 * passes the same validation without any of it being relaxed.
 */
export async function generatePlaceholderEpoch(
  input: GeneratePlaceholderEpochInput,
): Promise<void> {
  for (const directory of adaptiveOutputDirectories({
    videoOutputs: [...input.videoOutputs],
    audioOutputs: [],
  })) {
    await mkdir(path.join(input.directory, ...directory.split("/")), {
      recursive: true,
    });
  }
  await input.runEncoder(input.ffmpegPath, buildPlaceholderEpochArgs(input), {
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.pauseController
      ? { pauseController: input.pauseController }
      : {}),
    logPath: input.logPath,
    ...(input.watchdog ? { watchdog: input.watchdog } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
}
