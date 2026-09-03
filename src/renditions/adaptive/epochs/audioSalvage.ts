/**
 * A soundtrack built around a hole in the source.
 *
 * When a stretch of the film cannot be read, the video epoch covering it is
 * replaced with black — and the audio stage would then walk straight into the
 * same bad sectors and take the whole title down with it. So the audio pass is
 * told where the holes are and reads around them.
 *
 * The construction matters more than it looks. The obvious approach — encode
 * each readable stretch to its own file, encode silence for the gaps, and
 * concatenate the files — is wrong: every AAC part carries its own encoder
 * priming, and joining encoded parts adds that priming to the timeline at each
 * seam. A few tens of milliseconds per join walks the sound out of step with
 * the picture, permanently, in a way nothing downstream can detect.
 *
 * Instead the pieces are joined *before* the encoder. One FFmpeg process opens
 * the source once per readable stretch, generates silence for each gap, and
 * concatenates them inside the filter graph, so every track is one continuous
 * encode over the title's own timeline. There are no seams in the bitstream
 * because there are no separate encodes.
 */

import {
  deliveryChannelsFor,
  type AdaptiveAudioOutput,
  type AdaptiveEncodingInput,
} from "../encoding";
import { audioRenditionId } from "../profile";
import {
  planSourceRanges,
  type SourceInterval,
  type SourceRange,
} from "./salvage";

/** The rate every delivered track is resampled to before it is encoded. */
export const SALVAGE_AUDIO_SAMPLE_RATE = 48_000;

/** Channel layout name FFmpeg understands, for a delivered channel count. */
export function channelLayoutFor(channels: number): string {
  return channels <= 1 ? "mono" : "stereo";
}

/**
 * The silence generator for one gap in one track.
 *
 * `anullsrc` is given the layout and rate the track will be delivered at, and
 * the gap's exact length as an input duration, so the segment the filter graph
 * receives is precisely as long as the interval the source could not provide.
 */
export function silenceInput(
  range: SourceRange,
  channels: number,
): AdaptiveEncodingInput {
  return {
    path: `anullsrc=channel_layout=${channelLayoutFor(
      channels,
    )}:sample_rate=${SALVAGE_AUDIO_SAMPLE_RATE}`,
    format: "lavfi",
    durationSeconds: range.durationSeconds,
  };
}

export interface SalvagedAudioPlan {
  /** Every `-i`, in the order the arguments will name them. */
  inputs: AdaptiveEncodingInput[];
  /** The graph that concatenates each track's pieces into one stream. */
  filterComplex: string;
  /** The outputs, each mapping the label its concatenation produced. */
  outputs: AdaptiveAudioOutput[];
  /** The ranges the plan is built from, for the record and for the tests. */
  ranges: SourceRange[];
}

/**
 * Plans one FFmpeg invocation that produces every track around every hole.
 *
 * A silence generator cannot be shared between tracks — a filter pad may be
 * consumed once — so each track gets its own for each gap. That is a handful of
 * extra inputs on a job that only exists because a disk is failing, and it buys
 * a graph with no splitters in it.
 */
export function planSalvagedAudio({
  sourcePath,
  audioOutputs,
  damagedIntervals,
  sourceDurationSeconds,
}: {
  sourcePath: string;
  audioOutputs: readonly AdaptiveAudioOutput[];
  damagedIntervals: readonly SourceInterval[];
  sourceDurationSeconds: number;
}): SalvagedAudioPlan {
  const ranges = planSourceRanges(damagedIntervals, sourceDurationSeconds);
  if (ranges.length === 0) {
    throw new Error(
      "A salvaged soundtrack needs a source timeline with a positive duration.",
    );
  }
  if (audioOutputs.length === 0) {
    throw new Error("A salvaged soundtrack needs at least one track.");
  }

  const inputs: AdaptiveEncodingInput[] = [];
  /*
   * The readable stretches are opened once each and shared by every track: one
   * input carries all of the source's audio streams, so three tracks reading
   * the same five minutes is one read, not three.
   */
  const sourceInputIndex = new Map<number, number>();
  ranges.forEach((range, rangeOrdinal) => {
    if (range.kind !== "source") return;
    sourceInputIndex.set(rangeOrdinal, inputs.length);
    inputs.push({
      path: sourcePath,
      ...(range.startSeconds > 0 ? { startSeconds: range.startSeconds } : {}),
      durationSeconds: range.durationSeconds,
    });
  });

  const chains: string[] = [];
  const outputs: AdaptiveAudioOutput[] = audioOutputs.map(
    (output, trackOrdinal) => {
      const channels = deliveryChannelsFor(output.channels);
      const labels: string[] = [];
      ranges.forEach((range, rangeOrdinal) => {
        const label = `s${trackOrdinal}r${rangeOrdinal}`;
        let pad: string;
        if (range.kind === "source") {
          pad = `${sourceInputIndex.get(rangeOrdinal)!}:${output.sourceStreamIndex}`;
        } else {
          const generator = inputs.length;
          inputs.push(silenceInput(range, channels));
          pad = `${generator}:a:0`;
        }
        /*
         * Every piece is brought to the same rate, sample format and layout
         * before it is concatenated. The concat filter requires it, and doing
         * it here rather than trusting the source is what lets a 44.1 kHz
         * stretch and generated silence be joined without a click.
         */
        chains.push(
          `[${pad}]aresample=${SALVAGE_AUDIO_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=${channelLayoutFor(
            channels,
          )}[${label}]`,
        );
        labels.push(`[${label}]`);
      });
      chains.push(
        `${labels.join("")}concat=n=${labels.length}:v=0:a=1[aout${trackOrdinal}]`,
      );
      return {
        ...output,
        /*
         * Always encoded, never copied. A track assembled from source and
         * silence has to come out of one encoder with one set of parameters;
         * copying the readable stretches and encoding the gaps would produce a
         * file whose halves disagree about sample rate or profile.
         */
        action: "transcode" as const,
        channels,
        mapLabel: `[aout${trackOrdinal}]`,
      };
    },
  );

  return { inputs, filterComplex: chains.join(";"), outputs, ranges };
}

/** The rendition ids a salvaged plan will produce, for logging and progress. */
export function salvagedAudioRenditionIds(
  audioOutputs: readonly AdaptiveAudioOutput[],
): string[] {
  return audioOutputs.map((output) =>
    audioRenditionId(output.sourceStreamIndex),
  );
}

/**
 * Whether an audio stage on disk was built for exactly these holes.
 *
 * Compared to the millisecond rather than by identity: a stage built around a
 * hole must not be reused by a run that has found a different one, and a
 * healthy stage must not be reused once any hole is known.
 */
export function sameDamagedIntervals(
  left: readonly SourceInterval[] | undefined,
  right: readonly SourceInterval[] | undefined,
): boolean {
  const first = left ?? [];
  const second = right ?? [];
  if (first.length !== second.length) return false;
  return first.every((interval, index) => {
    const other = second[index]!;
    return (
      Math.abs(interval.startSeconds - other.startSeconds) < 0.001 &&
      Math.abs(interval.endSeconds - other.endSeconds) < 0.001
    );
  });
}
