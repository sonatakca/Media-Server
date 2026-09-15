import { describe, expect, it } from "vitest";
import {
  activityBins,
  alignSpeech,
  onsets,
  type SpeechInterval,
} from "./subtitleAlignment";

/**
 * A film's worth of dialogue, deterministically.
 *
 * Reproducing the shape of real speech matters more here than the numbers being
 * lifelike: the aligner's whole premise is that the *pattern* of talking is a
 * fingerprint, so a generator producing evenly spaced identical cues would be
 * testing something with no fingerprint at all. Gaps and durations vary through
 * a small irrational rotation, which never repeats and never needs a seed.
 */
function dialogue(
  count: number,
  options: { from?: number; step?: number } = {},
): SpeechInterval[] {
  const intervals: SpeechInterval[] = [];
  let at = options.from ?? 30;
  for (let index = 0; index < count; index += 1) {
    const wobble = (index * Math.SQRT2) % 1;
    const duration = 1 + wobble * 2;
    intervals.push({ startSeconds: at, endSeconds: at + duration });
    at += duration + (options.step ?? 2) + wobble * 3;
  }
  return intervals;
}

const shift = (
  intervals: readonly SpeechInterval[],
  offsetSeconds: number,
  rate = 1,
): SpeechInterval[] =>
  intervals.map((interval) => ({
    startSeconds: interval.startSeconds * rate + offsetSeconds,
    endSeconds: interval.endSeconds * rate + offsetSeconds,
  }));

describe("activityBins", () => {
  it("marks the bins an interval covers, widened by one either side", () => {
    const bins = activityBins([{ startSeconds: 5, endSeconds: 6 }], 20, 0.5);
    expect([...bins]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("does not run off either end of the grid", () => {
    expect([
      ...activityBins([{ startSeconds: 0, endSeconds: 8 }], 4, 1),
    ]).toEqual([1, 1, 1, 1]);
  });
});

describe("onsets", () => {
  it("returns starts in order whatever order the intervals arrived in", () => {
    expect([
      ...onsets([
        { startSeconds: 9, endSeconds: 10 },
        { startSeconds: 2, endSeconds: 3 },
      ]),
    ]).toEqual([2, 9]);
  });
});

describe("alignSpeech", () => {
  const reference = dialogue(900);

  it("finds a plain offset and is confident about it", () => {
    const proposal = alignSpeech(shift(reference, 14.5), reference);
    expect(proposal.offsetSeconds).toBeCloseTo(-14.5, 2);
    expect(proposal.rate).toBeCloseTo(1, 4);
    expect(proposal.confidence).toBeGreaterThan(0.5);
  });

  it("finds a negative offset just as well", () => {
    const proposal = alignSpeech(shift(reference, -42.25), reference);
    expect(proposal.offsetSeconds).toBeCloseTo(42.25, 2);
  });

  it("recovers a PAL frame-rate transfer", () => {
    const rate = 25 / 23.976;
    const proposal = alignSpeech(shift(reference, 3, rate), reference);
    expect(proposal.rate).toBeCloseTo(1 / rate, 4);
    expect(proposal.offsetSeconds + 3 / rate).toBeCloseTo(0, 1);
    expect(proposal.confidence).toBeGreaterThan(0.5);
  });

  it("recovers a small drift no frame-rate table contains", () => {
    /*
     * A tenth of a percent is not any transfer between two standard rates. The
     * coarse search cannot resolve it and is not expected to; this is the case
     * the iterative fit exists for.
     */
    const proposal = alignSpeech(shift(reference, 6, 1.001), reference);
    expect(proposal.rate).toBeCloseTo(1 / 1.001, 5);
    expect(proposal.confidence).toBeGreaterThan(0.5);
  });

  it("is unconvinced by two unrelated films", () => {
    const other = dialogue(900, { from: 55, step: 3.5 });
    expect(alignSpeech(other, reference).confidence).toBeLessThan(0.35);
  });

  it("reports an alignment already correct as no shift at all", () => {
    const proposal = alignSpeech(reference, reference);
    expect(proposal.offsetSeconds).toBeCloseTo(0, 3);
    expect(proposal.matchedFraction).toBeCloseTo(1, 2);
  });

  it("survives a reference that holds only some of the target's lines", () => {
    // What an audio track is: one stretch of speech where a subtitle has three
    // separate lines, so most cues can never match however right the answer is.
    const sparse = reference.filter((_, index) => index % 3 === 0);
    const proposal = alignSpeech(shift(reference, 9), sparse);
    expect(proposal.offsetSeconds).toBeCloseTo(-9, 1);
    expect(proposal.matchedFraction).toBeLessThan(0.5);
    expect(proposal.confidence).toBeGreaterThan(0.5);
  });

  it("answers rather than throws when a side is empty", () => {
    const proposal = alignSpeech([], reference);
    expect(proposal).toMatchObject({
      offsetSeconds: 0,
      rate: 1,
      confidence: 0,
    });
  });

  it("refuses to stretch a subtitle beyond any plausible transfer", () => {
    const proposal = alignSpeech(shift(reference, 0, 1.4), reference);
    expect(Math.abs(proposal.rate - 1)).toBeLessThan(0.12);
    expect(proposal.confidence).toBeLessThan(0.35);
  });
});
